import {
    type Api,
    type ApiResponse,
    Context,
    type Middleware,
    type RawApi,
    type SessionFlavor,
    type Update,
    type UserFromGetMe,
} from "./deps.deno.ts";

/** Identity function */
function ident<T>(arg: T) {
    return arg;
}
// Define which context properties are intrinsic to grammY and should not be
// stored alongside the update object
const INTRINSIC_CONTEXT_PROPS = new Set(["update", "api", "me", "session"]);
function IS_INTRINSIC(key: string) {
    return INTRINSIC_CONTEXT_PROPS.has(key);
}

/**
 * An interruptor wraps a promise so that it can be resolved by an outside
 * event. It is a container for this promise which you can `await`, and a
 * function `done` which you can call. Once you call `done`, the contained
 * promise will resolve.
 *
 * The status flag `waiting` indicates if `done` has been called or not.
 */
interface Interruptor {
    /** The promise which can be resolved by calling `done` */
    promise: Promise<void>;
    /** Resolves the promise of this interruptor */
    done: () => void;
    /**
     * A flag indicating whether `done` has been called, i.e. whether the
     * promise has been resolved. Has the value `true` until `done` is called.
     */
    waiting: boolean;
}
/** Creates a new interruptor */
function interruptor(): Interruptor {
    const intr: Interruptor = {
        waiting: true,
        // those two will be overwritten immediately:
        done: () => {},
        promise: Promise.resolve(),
    };
    intr.promise = new Promise((r) => intr.done = r);
    return intr;
}

/**
 * A user-defined builder function that can be turned into middleware for a
 * conversation.
 */
type ConversationBuilder<C extends Context> = (
    t: Conversation<C>,
    ctx: C,
) => unknown | Promise<unknown>;
/**
 * Context flavor for the conversations plugin. Adds the conversation control
 * panel `ctx.conversation` which e.g. allows entering a conversation, as well
 * as some properties to the session which the conversation plugin needs.
 */
export type ConversationFlavor<C extends Context> =
    & C
    & { conversation: ConversationControls<C> }
    & SessionFlavor<ConversationSessionData>;

/** Used to store data invisibly on the context object */
const internal = Symbol("conversations");
/**
 * The is the conversation control panel. It allows you to enter conversations.
 */
interface ConversationControls<C extends Context> {
    /** Index of all installed conversation builder functions */
    [internal]: Map<string, ConversationBuilder<C>>;
    /** Enters a conversation with the given identifier */
    enter(id: string): void;
    /**
     * Identifier of the currently active conversation. Undefined if no
     * conversation is active at the moment.
     */
    readonly activeId?: string;
    /**
     *  Hard-kills a conversation, no matter where it is. Use with caution.
     *  Usually, it's best to simply `return` from the conversation builder
     *  function instead.
     */
    exit(): void;
}

/** Data which the conversation plugin adds to `ctx.session` */
interface ConversationSessionData {
    /** Internal data used by the conversation plugin. Do not modify. */
    conversation?: {
        /** Identifier of the currently active conversation */
        activeId: string;
        /**
         * Log of operations that were performed so far in the conversation.
         * Used to replay past operations when resuming.
         */
        log: OpLog;
    };
}
/** Log of operations */
interface OpLog {
    entries: OpLogEntry[];
}
interface OpLogEntry {
    op: WaitOp | ApiOp | ExtOp;
}
/** A `wait` call that was recorded onto the log */
interface WaitOp {
    type: "wait";
    value: Update;
    /**
     * All enumerable properties on the context object which should be persisted
     * in the session and restored when replaying
     */
    extra: Record<string, unknown>;
}
/** A Bot API call that was recorded onto the log */
interface ApiOp {
    type: "api";
    value: ApiResponse<Awaited<ReturnType<RawApi[keyof RawApi]>>>;
}
/** An external operation that was recorded onto the log */
interface ExtOp {
    type: "ext";
    // deno-lint-ignore no-explicit-any
    value: any;
}
/**
 * Takes a conversation builder function, and turns it into grammY middleware
 * which can be installed on your bot. Check out the documentation to learn more
 * about how conversation builder functions can be created.
 *
 * @param builder Conversation builder function
 * @param id Identifier of the conversation, defaults to name of the function
 * @returns Middleware to be installed on the bot
 */
export function createConversation<C extends Context>(
    builder: ConversationBuilder<C>,
    id = builder.name,
): Middleware<ConversationFlavor<C>> {
    return async (ctx, next) => {
        /** Defines how to enter a conversation */
        function enter(id: string) {
            const s = ctx.session;
            if (s.conversation !== undefined) {
                throw new Error(
                    `Already in conversation ${s.conversation.activeId}`,
                );
            } else {
                // Simply set the active identifier to ours, we'll run the
                // builder after the downstream middleware has completed.
                s.conversation = { activeId: id, log: { entries: [] } };
            }
        }

        /** Defines how to leave the current conversation */
        function exit() {
            if (ctx.session?.conversation !== undefined) {
                // Simply clear the log and the active identifier
                ctx.session.conversation = undefined;
            }
        }

        /** Adds an entry for the current context object to the given log */
        function addContextToLog(log: OpLog) {
            // Need to log both update (in `value`) and all enumerable
            // properties on the context object (in `extra`).
            const value = ctx.update;
            const extra: Record<string, unknown> = {
                // Treat ctx.session differently, skip old conversation data
                session: Object.fromEntries(
                    Object.entries(ctx.session)
                        .filter(([k]) => k !== "conversation"),
                ),
            };
            // Copy over all remaining properties (except intrinsinc ones)
            Object.keys(ctx)
                .filter(IS_INTRINSIC)
                .forEach((key) => extra[key] = (ctx)[key as keyof C]);
            log.entries.push({ op: { type: "wait", value, extra } });
        }

        /** Defines how to run a conversation builder function */
        async function run(log: OpLog, target = builder) {
            // First log the current context object, then invoke the target.
            addContextToLog(log);

            // Invoke target: Used to catch `wait` calls, as we want to resume
            // execution then
            const onWait = interruptor();
            const conversation = new ConversationHandle<C>(
                log,
                ctx.api,
                ctx.me,
                onWait,
            );
            try {
                // Call the target builder function supplied by the user, but
                // don't blindly await it because when `wait` is called,
                // execution is aborted, so the `Promise.race` intercepts this
                // again and allows us to resume normal middleware handling.
                await Promise.race([onWait.promise, target(conversation, ctx)]);
            } finally {
                // If wait was not called, the conversation function completed
                // normally (either by returning or by throwing), so we exit
                if (!onWait.waiting) exit();
            }
        }

        // Register conversation controls on context if we are the first
        // installed middleware on the bot (so it has not been registered yet)
        const first = ctx.conversation === undefined;
        if (first) {
            ctx.conversation = {
                [internal]: new Map(),
                enter,
                exit,
                get activeId() {
                    return ctx.session?.conversation?.activeId;
                },
            };
        }

        // Add ourselves to the conversation index
        const map = ctx.conversation[internal];
        if (map.has(id)) {
            throw new Error(`Duplicate conversation identifier ${id}!`);
        }
        map.set(id, builder);

        // Continue last conversation if we are active
        if (ctx.session?.conversation?.activeId === id) {
            const log = ctx.session.conversation.log;

            // Run conversation builder function
            await run(log);
            return;
        }

        // No conversation running, call downstream middleware
        await next();

        // Run entered conversation if we are responsible
        if (first && ctx.session?.conversation !== undefined) {
            const { activeId, log } = ctx.session.conversation;
            await run(log, map.get(activeId));
        }
    };
}

/**
 * > This should be the first parameter in your conversation builder function.
 *
 * This object gives you access to your conversation. You can think of it as a
 * handle which lets you perform basic operations in your conversation, such as
 * waiting for new messages.
 *
 * Typically, a conversation builder function has this signature:
 *
 * ```ts
 * async function greet(conversation: Conversation<MyContext>, ctx: MyContext) {
 *   // define your conversation here
 * }
 * ```
 *
 * Check out the documentation to learn more about how to create conversations.
 */
export type Conversation<C extends Context> = ConversationHandle<C>;
class ConversationHandle<C extends Context> {
    /**
     * Index in the op log of the current replay operation. Points at the next
     * empty op log index if no replay operation is in progress. Note that in
     * the latter case, it equals the length of the op log.
     */
    private replayOpIndex = 0;

    constructor(
        private readonly opLog: OpLog,
        private api: Api,
        private me: UserFromGetMe,
        private onWait: Interruptor,
    ) {
        // We intercept Bot API calls, returning logged responses while
        // replaying, and logging the responses of performed calls otherwise.
        api.config.use(async (prev, method, payload, signal) => {
            if (this.replaying) return this.replayOp("api");
            const response = await prev(method, payload, signal);
            this.logOp({ op: { type: "api", value: response } });
            return response;
        });
    }

    /**
     * Internal flag, `true` if the conversation is currently replaying in order
     * to jump back to and old state, and `false` otherwise. Relying on this can
     * lead to very funky things, so only use this flag if you absolutely know
     * what you are doing.
     */
    get replaying() {
        return this.replayOpIndex < this.opLog.entries.length;
    }
    /** Retrieves the next logged operation from the stack while replaying */
    private replayOp<T extends OpLogEntry["op"]["type"]>(expectedType: T) {
        if (!this.replaying) {
            throw new Error(
                "Replay stack exhausted, you may not call this method!",
            );
        }
        const { op } = this.opLog.entries[this.replayOpIndex];
        if (op.type !== expectedType) {
            throw new Error(
                `Unexpected operation performed during replay (expected '${op.type}' \
but was '${expectedType}')! It looks likethe conversation builder function is \
non-deterministic, or it relies on external data sources.`,
            );
        }
        this.replayOpIndex++;
        switch (op.type) {
            case "wait":
                // Create fake context, and restore all enumerable properties
                return Object.assign(
                    new Context(op.value, this.api, this.me),
                    op.extra,
                );
            case "api":
            case "ext":
                return op.value;
        }
    }
    /**
     * Internal function which will be called to log new operations. Relying on
     * this can lead to very funky things, so only use this flag if you
     * absolutely know what you are doing.
     *
     * @param op Operation log entry
     */
    logOp(op: OpLogEntry) {
        if (!this.replaying) this.replayOpIndex++;
        this.opLog.entries.push(op);
    }

    /**
     * Waits for a new update (message, callback query, etc) from the user. Once
     * received, this method returns a
     */
    async wait(): Promise<C> {
        // If this is an old wait, simply return the old context object
        if (this.replaying) return this.replayOp("wait");
        // Notify the interruptor so that we can catch the function interception
        // and resume middleware execution normally outside of the conversation
        this.onWait.done();
        // Intercept function execution
        await new Promise(() => {}); // BOOM
        // deno-lint-ignore no-explicit-any
        return 0 as any; // dead code
    }
    /**
     * Safely performs an operation with side-effects. You must use this to wrap
     * all communication with external systems that does not go through grammY,
     * such as database communication or calls to external APIs.
     *
     * This function will then make sure the operation is only performed once,
     * and not every time a message is handled by the conversation.
     *
     * It will need to be able to store the result value of this operation in
     * the session. Hence, it must store and load the result of the operation
     * according to your storage adapter. It is therefore best to only return
     * primitive values or POJOs. If you need to transform your data before it
     * can be stored, you can specify the `beforeStore` function. If you need to
     * transform your data after it was loaded, you can specify the `afterLoad`
     * function.
     *
     * @param op An external operation to perform
     * @returns The result of the operation
     */
    // deno-lint-ignore no-explicit-any
    async external<F extends (...args: any[]) => any, I = any>(
        op: {
            /** An operation to perform */
            task: F;
            /** Parameters to supply to the operation */
            args?: Parameters<F>;
            /** Prepare the result for  */
            beforeStore?: (value: ReturnType<F>) => I | Promise<I>;
            afterLoad?: (value: I) => ReturnType<F>;
        },
    ): Promise<Awaited<ReturnType<F>>> {
        const { task, args = [], beforeStore = ident, afterLoad = ident } = op;
        // Return the old result if we are replaying
        if (this.replaying) return await afterLoad(this.replayOp("ext"));
        // Otherwise, execute the task and log its result
        const value = await task(...args);
        this.logOp({ op: { type: "ext", value: beforeStore(value) } });
        return value;
    }
    /**
     * Delays the rest of the conversation by the specified number of
     * milliseconds. You should use this instead of your own sleeping function
     * so that you don't block the conversation while it is restoring a previous
     * position.
     *
     * @param milliseconds The number of milliseconds to wait
     */
    async delay(milliseconds: number): Promise<void> {
        if (this.replaying) return;
        await new Promise((r) => setTimeout(r, milliseconds));
    }

    /**
     * Safely generates a random number from `Math.random()`. You should use
     * this instead of `Math.random()` in your conversation because
     * non-deterministic behavior is not allowed.
     *
     * @returns A random number
     */
    random() {
        return this.external({ task: () => Math.random() });
    }
}
