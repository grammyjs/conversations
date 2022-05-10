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
import { ident, IS_NOT_INTRINSIC, type Resolver, resolver } from "./utils.ts";

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
 * panel `ctx.conversation` which e.g. allows entering a conversation. It also
 * adds some properties to the session which the conversation plugin needs.
 */
export type ConversationFlavor<C extends Context> =
    & C
    & { conversation: ConversationControls<C> }
    & SessionFlavor<ConversationSessionData>;

/**
 * Used to store data invisibly on context object inside the conversation
 * control panel
 */
const internal = Symbol("conversations");
/**
 * The is the conversation control panel which is available on
 * `ctx.conversation`. It allows you to enter and exit conversations, and to
 * inspect which conversation is currently active.
 */
class ConversationControls<C extends Context> {
    /** Index of all installed conversation builder functions */
    readonly [internal] = new Map<string, ConversationBuilder<C>>();

    constructor(
        private readonly session: ConversationSessionData | undefined,
    ) {}

    /**
     * Identifier of the currently active conversation. Undefined if no
     * conversation is active at the moment.
     */
    get activeId() {
        return this.session?.conversation?.activeId;
    }

    /** Enters a conversation with the given identifier */
    public enter(id: string) {
        if (!this[internal].has(id)) {
            const keys = Array.from(this[internal].keys());
            const list = keys.map((key) => `'${key}'`).join(", ");
            throw new Error(
                `Conversation '${id}' is unknown! Known conversations are: ${list}`,
            );
        }
        const s = this.session;
        if (s === undefined) {
            throw new Error("Cannot enter a conversation without session!");
        }
        if (s.conversation !== undefined) {
            throw new Error(
                `Already in conversation '${s.conversation.activeId}'!`,
            );
        }
        // Simply set the active identifier to ours, we'll run the
        // builder after the downstream middleware has completed.
        s.conversation = { activeId: id, log: { entries: [] } };
    }

    /**
     *  Hard-kills a conversation as soon as the next `wait` call is reached.
     *  Performed implicitly if the conversation builder function completes or
     *  errors.
     */
    public exit() {
        if (this.session?.conversation !== undefined) {
            // Simply clear the log and the active identifier
            delete this.session.conversation;
        }
    }
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
    update: Update;
    /**
     * All enumerable properties on the context object which should be persisted
     * in the session and restored when replaying. Excludes intrinsic
     * properties.
     */
    extra: Record<string, unknown>;
}
/** A Bot API call that was recorded onto the log */
interface ApiOp {
    type: "api";
    response: ApiResponse<Awaited<ReturnType<RawApi[keyof RawApi]>>>;
}
/** An external operation that was recorded onto the log */
interface ExtOp {
    type: "ext";
    // deno-lint-ignore no-explicit-any
    result: any;
}

/**
 * Creates a runner function which is in turn able to execute conversation
 * builder functions based on an op log.
 */
function conversationRunner<C extends Context>(ctx: ConversationFlavor<C>) {
    /** Adds an entry for the current context object to the given log */
    function addContextToLog(log: OpLog) {
        // Need to log both update (in `update`) and all enumerable
        // properties on the context object (in `extra`).
        const { update, session } = ctx;
        const extra: Record<string, unknown> = {
            // Treat ctx.session differently, skip old conversation data
            session: Object.fromEntries(
                Object.entries(session).filter(([k]) => k !== "conversation"),
            ),
        };
        // Copy over all remaining properties (except intrinsic ones)
        Object.keys(ctx)
            .filter(IS_NOT_INTRINSIC)
            .forEach((key) => extra[key] = ctx[key as keyof C]);
        log.entries.push({ op: { type: "wait", update, extra } });
    }

    /** Defines how to run a conversation builder function */
    async function run(builder: ConversationBuilder<C>, log: OpLog) {
        // We are either starting the conversation builder function from
        // scratch, or we are beginning a replay operation. In both cases, the
        // current context object is new to the conversation builder function,
        // be it the inital context object or the result of a `wait` call.
        // Hence, we should log the current context object.
        addContextToLog(log);
        // Now, we invoke the conversation builder function.
        const { api, me } = ctx;
        const rsr = resolver(); // used to catch `wait` calls
        const conversation = new ConversationHandle<C>(log, api, me, rsr);
        // Replay the initial context object manually
        const initialContext = conversation._replayOp("wait");
        try {
            // Call the target builder function supplied by the user, but
            // don't blindly await it because when `wait` is called
            // somewhere inside, execution is aborted. The `Promise.race`
            // intercepts this again and allows us to resume normal
            // middleware handling.
            await Promise.race([
                rsr.promise,
                builder(conversation, initialContext),
            ]);
        } finally {
            // If wait was not called, the conversation function completed
            // normally (either by returning or by throwing), so we exit
            if (!rsr.isResolved) ctx.conversation.exit();
        }
    }

    return run;
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
    if (!id) throw new Error("Cannot register a function without name!");
    return async (ctx, next) => {
        // Define how to run a conversation builder function
        const run = conversationRunner(ctx);

        // Register conversation controls on context if we are the first
        // installed middleware on the bot (so it has not been registered yet)
        const first = ctx.conversation === undefined;
        if (first) ctx.conversation = new ConversationControls(ctx.session);

        // Add ourselves to the conversation index
        const map = ctx.conversation[internal];
        if (map.has(id)) {
            throw new Error(`Duplicate conversation identifier '${id}'!`);
        }
        map.set(id, builder);

        // Continue last conversation if we are active
        if (ctx.session?.conversation?.activeId === id) {
            await run(builder, ctx.session.conversation.log);
            return;
        }

        // No conversation running, call downstream middleware
        await next();

        // Run entered conversation if we are responsible
        if (first && ctx.session?.conversation !== undefined) {
            const { activeId, log } = ctx.session.conversation;
            const target = map.get(activeId);
            if (target === undefined) {
                throw new Error(
                    `Entered unknown conversation, cannot run '${activeId}'!`,
                );
            }
            await run(target, log);
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
     * Index in the op log of the current replay operation. Points at the
     * next empty op log index if no replay operation is in progress. Note
     * that in the latter case, it equals the length of the op log.
     */
    private replayOpIndex = 0;

    constructor(
        private readonly opLog: OpLog,
        private api: Api,
        private me: UserFromGetMe,
        private rsr: Resolver,
    ) {
        // We intercept Bot API calls, returning logged responses while
        // replaying, and logging the responses of performed calls otherwise.
        api.config.use(async (prev, method, payload, signal) => {
            if (this._isReplaying) return this._replayOp("api");
            const response = await prev(method, payload, signal);
            this._logOp({ op: { type: "api", response: response } });
            return response;
        });
    }

    /**
     * Internal flag, `true` if the conversation is currently replaying in order
     * to jump back to an old state, and `false` otherwise. Relying on this can
     * lead to very funky things, so only use this flag if you absolutely know
     * what you are doing. Most likely, you should not use this at all.
     */
    get _isReplaying() {
        return this.replayOpIndex < this.opLog.entries.length;
    }
    /**
     * Internal method, retrieves the next logged operation from the stack while
     * replaying, and advances the replay cursor. Relying on this can
     * lead to very funky things, so only use this flag if you absolutely know
     * what you are doing. Most likely, you should not use this at all.
     */
    _replayOp<T extends OpLogEntry["op"]["type"]>(expectedType: T) {
        if (!this._isReplaying) {
            throw new Error(
                "Replay stack exhausted, you may not call this method!",
            );
        }
        const { op } = this.opLog.entries[this.replayOpIndex];
        if (op.type !== expectedType) {
            throw new Error(
                `Unexpected operation performed during replay (expected '${op.type}' \
but was '${expectedType}')! It looks like the conversation builder function is \
non-deterministic, or it relies on external data sources.`,
            );
        }
        this.replayOpIndex++;
        switch (op.type) {
            case "wait":
                // Create fake context, and restore all enumerable properties
                return Object.assign(
                    new Context(op.update, this.api, this.me),
                    op.extra,
                );
            case "api":
                return op.response;
            case "ext":
                return op.result;
        }
    }
    /**
     * Internal function which will be called to log new operations. Relying on
     * this can lead to very funky things, so only use this flag if you
     * absolutely know what you are doing. Most likely, you should not use this
     * at all.
     *
     * @param op Operation log entry
     */
    _logOp(op: OpLogEntry) {
        if (!this._isReplaying) this.replayOpIndex++;
        this.opLog.entries.push(op);
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) from the
     * user. Once received, this method returns the new context object for the
     * incoming update.
     */
    async wait(): Promise<C> {
        // If this is an old wait, simply return the old context object
        if (this._isReplaying) return this._replayOp("wait");
        // Notify the resolver so that we can catch the function interception
        // and resume middleware execution normally outside of the conversation
        this.rsr.resolve();
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
            afterLoad?: (value: I) => ReturnType<F> | Promise<ReturnType<F>>;
        },
    ): Promise<Awaited<ReturnType<F>>> {
        const { task, args = [], beforeStore = ident, afterLoad = ident } = op;
        // Return the old result if we are replaying
        if (this._isReplaying) return await afterLoad(this._replayOp("ext"));
        // Otherwise, execute the task and log its result
        const value = await task(...args);
        this._logOp({ op: { type: "ext", result: await beforeStore(value) } });
        return value;
    }
    /**
     * Sleep for the specified number of milliseconds. You should use this
     * instead of your own sleeping function so that you don't block the
     * conversation while it is restoring a previous position.
     *
     * @param milliseconds The number of milliseconds to wait
     */
    async sleep(milliseconds: number): Promise<void> {
        if (this._isReplaying) return;
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
    /**
     * Safely perform `console.log` calls, but only when they should really be
     * logged (so not during replay operations).
     *
     * @param args Arguments to pass to `console.log`
     */
    log(...args: Parameters<typeof console.log>) {
        if (!this._isReplaying) console.log(...args);
    }
}
