import {
    type Api,
    type ApiResponse,
    Context,
    type Filter,
    type FilterQuery,
    type LazySessionFlavor,
    matchFilter,
    type MiddlewareFn,
    type RawApi,
    type SessionFlavor,
    type Update,
    type User,
    type UserFromGetMe,
} from "./deps.deno.ts";
import { ident, IS_NOT_INTRINSIC, type Resolver, resolver } from "./utils.ts";

/**
 * A user-defined builder function that can be turned into middleware for a
 * conversation.
 */
type ConversationBuilder<C extends Context> = (
    conversation: Conversation<C>,
    ctx: C,
) => unknown | Promise<unknown>;
/**
 * Context flavor for the conversations plugin. Adds the conversation control
 * panel `ctx.conversation` which e.g. allows entering a conversation. It also
 * adds some properties to the session which the conversation plugin needs.
 */
export type ConversationFlavor =
    & { conversation: ConversationControls }
    & (
        | SessionFlavor<ConversationSessionData>
        | LazySessionFlavor<ConversationSessionData>
    );

interface Internals {
    /** Known conversation identifiers, used for collision checking */
    ids: Set<string>;
}

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
class ConversationControls {
    /** List of all conversations to be started */
    readonly [internal]: Internals = { ids: new Set() };

    constructor(
        private readonly session: ConversationSessionData,
    ) {}

    /**
     * Returns a map of the identifiers of currently active conversations to the
     * number of times this conversation is active in the current chat. For
     * example, you can use `"captcha" in ctx.conversation.active` to check if
     * there are any active conversations in this chat with the identifier
     * `"captcha"`.
     */
    get active() {
        return Object.fromEntries(
            Object.entries(this.session.conversation ?? {})
                .map(([id, conversations]) => [id, conversations.length]),
        );
    }

    /** Enters a conversation with the given identifier */
    public enter(id: string, _opts: {
        /**
         * Specify `true` if all running conversations in the same chat should
         * be terminated before entering this conversation. Defaults to `false`.
         */
        overwrite?: boolean;
    } = {}): Promise<void> {
        const known = Array.from(this[internal].ids.values())
            .map((id) => `'${id}'`)
            .join(", ");
        throw new Error(
            `The conversation '${id}' has not been registered! Known conversations are: ${known}`,
        );
    }

    /**
     * Kills all conversations with the given identifier (if any) and enters a
     * new conversation for this identifier. Equivalent to passing `overwrite:
     * true` to `enter`.
     */
    public reenter(id: string) {
        this.enter(id, { overwrite: true });
    }

    /**
     * Hard-kills all conversations for a given identifier. Note that the normal
     * way for conversations to exit is for their conversation builder function
     * to complete (return or throw).
     *
     * If no identifier is specified, all running conversations of all
     * identifiers will be killed.
     */
    public exit(id?: string) {
        const session = this.session;
        if (session.conversation === undefined) return;
        if (id === undefined) {
            // Simply clear all conversation data
            delete session.conversation;
        } else {
            // Strip out specified conversations from active ones
            delete session.conversation[id];
            // Do not store empty object
            if (Object.keys(session.conversation).length === 0) {
                delete session.conversation;
            }
        }
    }
}

/** Data which the conversation plugin adds to `ctx.session` */
interface ConversationSessionData {
    /** Internal data used by the conversation plugin. Do not modify. */
    conversation?: Record<string, ActiveConversation[]>;
}
interface ActiveConversation {
    /**
     * Log of operations that were performed so far in the conversation.
     * Used to replay past operations when resuming.
     */
    log: OpLog;
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
    result: { ok: true; value: any } | { ok: false; error: unknown };
}

/** Ops that can lead to intertuption of function execution */
type ResolveOps = "wait" | "skip" | "done";

/**
 * Creates a runner function which is in turn able to execute conversation
 * builder functions based on an op log.
 */
function conversationRunner<C extends Context>(
    ctx: C & ConversationFlavor,
    builder: ConversationBuilder<C>,
) {
    /**
     * Adds an entry for the current context object to the given log,
     * effectively turning the most recent wait op into a old wait which will be
     * replayed
     */
    function receiveUpdate(log: OpLog) {
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

    /**
     * Defines how to run a conversation builder function. Returns `false` if
     * the conversation decided to pass on the control flow, and `true` if it
     * handled the update, i.e. completed normally or via a wait call. Note that
     * this function re-throws errors thrown by the conversation.
     */
    async function run(log: OpLog) {
        // We are either starting the conversation builder function from
        // scratch, or we are beginning a replay operation. In both cases, the
        // current context object is new to the conversation builder function,
        // be it the inital context object or the result of a `wait` call.
        // Hence, we should log the current context object.
        receiveUpdate(log);
        // Now, we invoke the conversation builder function.
        const { api, me } = ctx;
        const rsr = resolver<ResolveOps>(); // used to catch `wait` calls
        const handle = new ConversationHandle<C>(log, api, me, rsr);
        // Replay the initial context object manually
        const initialContext = handle._replayOp("wait");
        // Call the target builder function supplied by the user, but
        // don't blindly await it because when `wait` is called
        // somewhere inside, execution is aborted. The `Promise.race`
        // intercepts this again and allows us to resume normal
        // middleware handling.
        try {
            await Promise.race([rsr.promise, builder(handle, initialContext)]);
        } finally {
            handle._deactivate();
        }
        return rsr.value ?? "done";
    }

    return run;
}

export function conversations<C extends Context>(): MiddlewareFn<
    C & ConversationFlavor
> {
    return async (ctx, next) => {
        const session = await ctx.session;
        if (session === undefined) {
            throw new Error("Cannot register a conversation without session!");
        }
        ctx.conversation ??= new ConversationControls(session);
        await next();
    };
}

/**
 * Takes a conversation builder function, and turns it into grammY middleware
 * which can be installed on your bot. Check out the
 * [documentation](https://grammy.dev/plugins/conversations.html) to learn more
 * about how conversation builder functions can be created.
 *
 * @param builder Conversation builder function
 * @param id Identifier of the conversation, defaults to name of the function
 * @returns Middleware to be installed on the bot
 */
export function createConversation<C extends Context>(
    builder: ConversationBuilder<C>,
    id = builder.name,
): MiddlewareFn<C & ConversationFlavor> {
    if (!id) throw new Error("Cannot register a function without name!");
    return async (ctx, next) => {
        if (ctx.conversation === undefined) {
            throw new Error(
                "Cannot register a conversation without first installing the conversations plugin!",
            );
        }

        // Define how to run a conversation builder function
        const runOnLog = conversationRunner(ctx, builder);

        /**
         * Runs our conversation builder function for all given logs in
         * ascending order until the first decides to handle the update.
         */
        async function runUntilComplete(conversations: ActiveConversation[]) {
            let op: ResolveOps = "skip";
            for (let i = 0; op === "skip" && i < conversations.length; i++) {
                const current = conversations[i];
                try {
                    op = await runOnLog(current.log);
                } catch (e) {
                    conversations.splice(i, 1);
                    throw e;
                }
                if (op === "done") conversations.splice(i, 1);
            }
            return op;
        }

        // Add ourselves to the conversation index
        const index = ctx.conversation[internal].ids;
        if (index.has(id)) {
            throw new Error(`Duplicate conversation identifier '${id}'!`);
        }
        index.add(id);

        // Register ourselves in the enter function
        const oldEnter = ctx.conversation.enter.bind(ctx.conversation);
        ctx.conversation.enter = async (enterId, opts) => {
            if (enterId !== id) {
                await oldEnter(enterId, opts);
                return;
            }
            const session = await ctx.session;
            session.conversation ??= {};
            const entry: ActiveConversation = { log: { entries: [] } };
            const append = [entry];
            if (opts?.overwrite) session.conversation[id] = append;
            else (session.conversation[id] ??= []).push(...append);
            const pos = session.conversation[id].length - 1;
            try {
                await runUntilComplete(append);
            } finally {
                if (append.length === 0) {
                    session.conversation[id].splice(pos, 1);
                }
                if (session.conversation[id].length === 0) {
                    delete session.conversation[id];
                }
            }
        };

        const session = await ctx.session;
        try {
            // Run all existing conversations with our identifier
            let op: ResolveOps = "skip";
            if (session.conversation?.[id] !== undefined) {
                try {
                    op = await runUntilComplete(session.conversation[id]);
                } finally {
                    // Clean up if no logs remain
                    if (session.conversation[id].length === 0) {
                        delete session.conversation[id];
                    }
                }
            }

            // If all ran conversations (if any) called skip as their last op, we
            // run the downstream middleware
            if (op === "skip") await next();
        } finally {
            // Clean up if no conversations remain
            if (
                session.conversation !== undefined &&
                Object.keys(session.conversation).length === 0
            ) {
                delete session.conversation;
            }
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
 * Check out the [documentation](https://grammy.dev/plugins/conversations.html)
 * to learn more about how to create conversations.
 */
export type Conversation<C extends Context> = ConversationHandle<C>;
/**
 * Internally used class which acts as a conversation handle.
 */
export class ConversationHandle<C extends Context> {
    /**
     * Index in the op log of the current replay operation. Points at the
     * next empty op log index if no replay operation is in progress. Note
     * that in the latter case, it equals the length of the op log.
     */
    private replayOpIndex = 0;
    private active = true;

    constructor(
        private readonly opLog: OpLog,
        private api: Api,
        private me: UserFromGetMe,
        private rsr: Resolver<ResolveOps>,
    ) {
        // We intercept Bot API calls, returning logged responses while
        // replaying, and logging the responses of performed calls otherwise.
        api.config.use(async (prev, method, payload, signal) => {
            if (!this.active) return prev(method, payload, signal);
            // deno-lint-ignore no-explicit-any
            if (this._isReplaying) return this._replayOp("api") as any;
            const response = await prev(method, payload, signal);
            this._logOp({ op: { type: "api", response: response } });
            return response;
        });
    }

    _deactivate() {
        this.active = false;
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
    _replayOp(expectedType: "wait"): C;
    _replayOp(expectedType: "api"): ApiOp["response"];
    _replayOp(expectedType: "ext"): ExtOp["result"];
    _replayOp(expectedType: OpLogEntry["op"]["type"]) {
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
                ) as C;
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
    _unlogOp() {
        const op = this.opLog.entries.pop();
        if (op === undefined) throw new Error("Empty log, cannot unlog!");
        if (!this._isReplaying) this.replayOpIndex--;
        return op;
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
        this.rsr.resolve("wait");
        // Intercept function execution
        await new Promise<never>(() => {}); // BOOM
        // deno-lint-ignore no-explicit-any
        return 0 as any; // dead code
    }

    async waitUntil<D extends C>(
        predicate: (ctx: C) => ctx is D,
    ): Promise<D>;
    async waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
    ): Promise<C>;
    async waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
    ): Promise<C> {
        const ctx = await this.wait();
        if (!await predicate(ctx)) await this.skip();
        return ctx;
    }

    async waitUnless(
        predicate: (ctx: C) => boolean | Promise<boolean>,
    ): Promise<C> {
        return await this.waitUntil(async (ctx) => !await predicate(ctx));
    }

    async waitFor<Q extends FilterQuery>(
        query: Q | Q[],
    ): Promise<Filter<C, Q>> {
        const predicate: (ctx: C) => ctx is Filter<C, Q> = matchFilter(query);
        return await this.waitUntil(predicate);
    }

    async waitFrom(user: number | User): Promise<C & { from: User }> {
        const id = typeof user === "number" ? user : user.id;
        const predicate = (ctx: C): ctx is C & { from: User } =>
            ctx.from?.id === id;
        return await this.waitUntil(predicate);
    }

    // TODO: implement command matching
    // TODO: implement hears matching
    // TODO: implement callback, game, and inline query matching

    /**
     * Skips handling the update that was received in the last `wait` call. Once
     * called, the conversation resets to the last `wait` call, as if the update
     * had never been received. The control flow is passed on immediately, so
     * that downstream middleware can continue handling the update.
     *
     * Effectively, calling `await conversation.skip()` behaves as if this
     * conversation had not received the update at all.
     *
     * Make sure not to perform any actions between the last wait call and the
     * skip call. While the conversation rewinds its log internally, it does not
     * unsend messages that you sent between calling `wait` and calling `skip`.
     */
    async skip() {
        // We decided not to handle this update, so we purge all log entries
        // until the most recent wait entry inclusively from the log, before
        // passing on the control flow
        const log = this.opLog.entries;
        let reachedWait = false;
        do {
            reachedWait = this._unlogOp().op.type === "wait";
        } while (!reachedWait && log.length > 0);
        // Notify the resolver so that we can catch the function interception
        // and resume middleware execution normally outside of the conversation
        this.rsr.resolve("skip");
        // Intercept function execution
        return await new Promise<never>(() => {}); // BOOM
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
        op: F | {
            /** An operation to perform */
            task: F;
            /** Parameters to supply to the operation */
            args?: Parameters<F>;
            /** Prepare the result for storing */
            beforeStore?: (value: ReturnType<F>) => I | Promise<I>;
            /** Recover a result after storing */
            afterLoad?: (value: I) => ReturnType<F> | Promise<ReturnType<F>>;
            /** Prepare the result for storing */
            beforeStoreError?: (value: unknown) => unknown | Promise<unknown>;
            /** Recover a result after storing */
            afterLoadError?: (value: unknown) => unknown;
        },
    ): Promise<Awaited<ReturnType<F>>> {
        if (typeof op === "function") op = { task: op };
        const {
            task,
            args = [],
            beforeStore = ident,
            afterLoad = ident,
            beforeStoreError = ident,
            afterLoadError = ident,
        } = op;
        // Return the old result if we are replaying
        if (this._isReplaying) {
            const result = this._replayOp("ext");
            if (result.ok) return await afterLoad(result.value);
            else throw await afterLoadError(result.error);
        }
        // Otherwise, execute the task and log its result
        try {
            const result = await task(...args);
            const value = await beforeStore(result);
            this._logOp({ op: { type: "ext", result: { ok: true, value } } });
            return result;
        } catch (value) {
            const error = await beforeStoreError(value);
            this._logOp({ op: { type: "ext", result: { ok: false, error } } });
            throw value;
        }
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
