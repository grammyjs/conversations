import {
    type ApiResponse,
    Context,
    type Filter,
    type FilterQuery,
    type LazySessionFlavor,
    type MiddlewareFn,
    type RawApi,
    type SessionFlavor,
    type Update,
    type User,
} from "./deps.deno.ts";
import { ConversationForm } from "./form.ts";
import {
    clone,
    deepFreeze,
    ident,
    IS_NOT_INTRINSIC,
    type Resolver,
    resolver,
} from "./utils.ts";

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
export type ConversationFlavor<C> =
    C & { conversation: ConversationControls }
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
        private readonly session: () => Promise<ConversationSessionData>,
    ) {}

    /**
     * Returns a map of the identifiers of currently active conversations to the
     * number of times this conversation is active in the current chat. For
     * example, you can use `"captcha" in ctx.conversation.active` to check if
     * there are any active conversations in this chat with the identifier
     * `"captcha"`.
     */
    async active() {
        return Object.fromEntries(
            Object.entries((await this.session()).conversation ?? {})
                .map(([id, conversations]) => [id, conversations.length]),
        );
    }

    /**
     * Enters a conversation with the given identifier.
     *
     * Note that this method is async. You must `await` this method.
     */
    public enter(id: string, _opts: {
        /**
         * Specify `true` if all running conversations in the same chat should
         * be terminated before entering this conversation. Defaults to `false`.
         */
        overwrite?: boolean;
    } = {}): Promise<void> {
        // Each installed conversation will wrap this function and intercept the
        // call chain for their own identifier, so if we are actually called, an
        // unknown identifier was passed. Hence, we simply throw an error.
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
     *
     * Note that this method is async. You must `await` this method.
     */
    public async reenter(id: string) {
        await this.enter(id, { overwrite: true });
    }

    /**
     * Hard-kills all conversations for a given identifier. Note that the normal
     * way for conversations to exit is for their conversation builder function
     * to complete (return or throw).
     *
     * If no identifier is specified, all running conversations of all
     * identifiers will be killed.
     */
    public async exit(id?: string) {
        const session = await this.session();
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

/** Data which the conversations plugin adds to `ctx.session` */
interface ConversationSessionData {
    /** Internal data used by the conversations plugin. Do not modify. */
    conversation?: Record<string, ActiveConversation[]>;
}
interface ActiveConversation {
    /**
     * Log of operations that were performed so far in the conversation. Used to
     * replay past operations when resuming.
     */
    log: OpLog;
}
/**
 * Describes a log entry that does not only know its chronological position in
 * the log which indicates in what order the op was created, but also stores the
 * index at which the operation resolved. This makes it possible to accurately
 * track concurrent operations and deterministically replay the order in which
 * they resolved.
 */
interface AsyncOrder {
    /** Index used to determine the op resolve order */
    i: number;
}
/** Log of operations */
interface OpLog {
    /** Strictly ordered log of incoming updates */
    u: WaitOp[];
}
/** A `wait` call that was recorded onto the log */
interface WaitOp {
    /** Incoming update object used to recreate the context */
    u: Update;
    /**
     * All enumerable properties on the context object which should be persisted
     * in the session and restored when replaying. Excludes intrinsic
     * properties.
     */
    x: Record<string, unknown>;
    /**
     * All properties on the context object, enumerable or not, which could not
     * be persisted and will be proxied to the alive context object.
     */
    f?: string[];
    /** Method-keyed log of async-ordered API call results */
    a?: Record<string, ApiOp[]>;
    /** Log of async-ordered external operation results */
    e?: ExtOp[];
}
/** A Bot API call that was recorded onto the log */
interface ApiOp extends AsyncOrder {
    /** API call result, absent if the call did not complete in time */
    r?: ApiResponse<Awaited<ReturnType<RawApi[keyof RawApi]>>>;
}
/** An external operation that was recorded onto the log */
interface ExtOp extends AsyncOrder {
    /** Result of the task, absent if it did not complete in time */
    r?: {
        /** The operation succeeded and `v` was returned */
        // deno-lint-ignore no-explicit-any
        v: any;
    } | {
        /** The operation failed and `e` was thrown */
        e: unknown;
    };
}

/** Ops that can lead to intertuption of function execution */
type ResolveOps = "wait" | "skip" | "done";

/**
 * Creates a runner function which is in turn able to execute conversation
 * builder functions based on an op log.
 */
function conversationRunner<C extends Context>(
    ctx: C & ConversationFlavor<C>,
    builder: ConversationBuilder<C>,
) {
    /**
     * Adds an entry for the current context object to the given log,
     * effectively turning the most recent wait op into a old wait which will be
     * replayed
     */
    function receiveUpdate(log: OpLog) {
        // Need to log both update (in `update`) and all enumerable properties
        // on the context object (in `extra`).
        let functions: string[] | undefined;
        const extra = Object.fromEntries(
            Object.entries(ctx)
                // Do not copy over intrinsic properties
                .filter(([k]) => IS_NOT_INTRINSIC(k))
                .map(([k, v]) => [k, v, clone(v)])
                // Remember functions
                .filter(([k, v, c]) => {
                    if (v !== undefined && c === undefined) {
                        (functions ??= []).push(k);
                        return false;
                    }
                    return true;
                })
                .map(([k, , c]) => [k, c]),
        );
        // Do not store old session data, removing a lot of unused data
        delete extra.session.conversation;
        log.u.push({ u: ctx.update, x: extra, f: functions });
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
        const rsr = resolver<ResolveOps>(); // used to catch `wait` calls
        const handle = new ConversationHandle<C>(ctx, log, rsr);
        // Replay the initial context object manually
        const initialContext = handle._replayWait();
        // Call the target builder function supplied by the user, but don't
        // blindly await it because when `wait` is called somewhere inside,
        // execution is aborted. The `Promise.race` intercepts this again and
        // allows us to resume normal middleware handling.
        try {
            await Promise.race([rsr.promise, builder(handle, initialContext)]);
        } finally {
            handle._deactivate();
        }
        return rsr.value ?? "done";
    }

    return run;
}

/**
 * Main installer of the conversations plugin. Call this function and pass the
 * result to `bot.use`:
 *
 * ```ts
 * bot.use(conversations());
 * ```
 *
 * This registers the control panel for conversations which is available through
 * `ctx.conversation`. After installing this plugin, you are already able to
 * exit conversations, even before registering them.
 *
 * Moreover, this function is the prerequisite for being able to register the
 * actual conversations which can in turn be entered.
 *
 * ```ts
 * function settings(conversation: MyConversation, ctx: MyContext) {
 *     // define your conversation here
 * }
 * bot.use(createConversation(settings));
 * bot.command("settings", async (ctx) => {
 *     await ctx.conversation.enter("settings");
 * });
 * ```
 *
 * Check out the [documentation](https://grammy.dev/plugins/conversations.html)
 * to learn more about how to create conversations.
 */
export function conversations<C extends Context>(): MiddlewareFn<
    C & ConversationFlavor<C>
> {
    return async (ctx, next) => {
        if (!("session" in ctx)) {
            throw new Error("Cannot use conversations without session!");
        }
        ctx.conversation ??= new ConversationControls(() =>
            // Access session lazily
            Promise.resolve(ctx.session)
        );
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
 * @param id Identifier of the conversation, defaults to `builder.name`
 * @returns Middleware to be installed on the bot
 */
export function createConversation<C extends Context>(
    builder: ConversationBuilder<C>,
    id = builder.name,
): MiddlewareFn<C & ConversationFlavor<C>> {
    if (!id) throw new Error("Cannot register a function without name!");
    return async (ctx, next) => {
        if (ctx.conversation === undefined) {
            throw new Error(
                "Cannot register a conversation without first installing the conversations plugin!",
            );
        }

        // Add ourselves to the conversation index
        const index = ctx.conversation[internal].ids;
        if (index.has(id)) {
            throw new Error(`Duplicate conversation identifier '${id}'!`);
        }
        index.add(id);

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

        // Register ourselves in the enter function
        const oldEnter = ctx.conversation.enter.bind(ctx.conversation);
        ctx.conversation.enter = async (enterId, opts) => {
            if (enterId !== id) {
                await oldEnter(enterId, opts);
                return;
            }
            const session = await ctx.session;
            session.conversation ??= {};
            const entry: ActiveConversation = { log: { u: [] } };
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

            // If all ran conversations (if any) called skip as their last op,
            // we run the downstream middleware
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
 * Index of a replay operation. Used while replaying a function to where it left
 * off after the last wait call was reached.
 */
interface ReplayIndex {
    /**
     * Index of the current wait operation.
     *
     * If this value equals the length of the wait op log, it means that the
     * next wait operation is undefined so far. In other words, the conversation
     * builder function needs to be executed normally, whithout replaying.
     * Hence, this value can be used to check if the replay operation is still
     * active.
     */
    wait: number;
    /**
     * For every API method in the API call log, stores the index of the next
     * API call result.
     */
    api?: Map<string, number>;
    /**
     * Index of the next external operation that will be called.
     */
    ext?: number;
    /**
     * Index of the next operation that should resolve. Will be incremented
     * every time an API call or an external operation completes. This allows us
     * to accurately restore the order in which concurrent operations complete.
     */
    resolve?: number;
    /**
     * Index of all currently pending tasks. The promises are assigned to the
     * array in an arbitrary order, and will be resolved in ascending order.
     */
    tasks?: Array<Resolver<unknown>>;
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
 * It may be helpful to define a type alias.
 *
 * ```ts
 * type MyConversation = Conversation<MyContext>
 *
 * async function greet(conversation: MyConversation, ctx: MyContext) {
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
    private replayIndex: ReplayIndex = { wait: 0 };
    private active = true;

    constructor(
        private readonly ctx: C,
        private readonly opLog: OpLog,
        private readonly rsr: Resolver<ResolveOps>,
    ) {
        // We intercept Bot API calls, returning logged responses while
        // replaying, and logging the responses of performed calls otherwise.
        ctx.api.config.use(async (prev, method, payload, signal) => {
            if (!this.active) return prev(method, payload, signal);
            // deno-lint-ignore no-explicit-any
            if (this._isReplaying) return this._replayApi(method) as any;
            const slot = this._logApi(method);
            const result = await prev(method, payload, signal);
            slot.r = result;
            this._finalize(slot);
            return result;
        });
    }

    /**
     * Internal method, deactivates the conversation handle. Do not use unless
     * you know exactly what you are doing.
     */
    _deactivate() {
        this.active = false;
    }

    /**
     * Internal flag, `true` if the conversation is currently replaying in order
     * to jump back to an old state, and `false` otherwise. Do not use unless
     * you know exactly what you are doing.
     */
    get _isReplaying() {
        return this.replayIndex.wait < this.opLog.u.length;
    }
    /**
     * Internal method, replays a wait operation and advances the replay cursor.
     * Do not use unless you know exactly what you are doing.
     */
    _replayWait(): C {
        if (!this._isReplaying) {
            throw new Error(
                "Replay stack exhausted, you may not call this method!",
            );
        }
        if (this.replayIndex.wait > 0) {
            // Previous session won't be saved anymore so we freeze it
            deepFreeze(this.opLog.u[this.replayIndex.wait - 1].x.session);
        }
        const { u, x, f = [] } = this.opLog.u[this.replayIndex.wait];
        this.replayIndex = { wait: 1 + this.replayIndex.wait };
        // Use a dummy conversation control panel inside conversations
        const reject = () => {
            const error =
                "You cannot use `ctx.conversation` from within a conversation!";
            return Promise.reject(new Error(error));
        };
        const conversation = new ConversationControls(reject);
        conversation.enter = conversation.reenter = conversation.exit = reject;
        const controls = { conversation };
        // Return original context if we're about to resume execution
        if (!this._isReplaying) return Object.assign(this.ctx, controls);
        // Create fake context, and restore all enumerable properties
        const ctx = Object.assign(
            new Context(u, this.ctx.api, this.ctx.me),
            x,
            controls,
        ) as C;
        // Copy over functions which we could not store
        // deno-lint-ignore no-explicit-any
        f.forEach((p) => (ctx as any)[p] = (this.ctx as any)[p].bind(this.ctx));
        return ctx;
    }

    /**
     * Internal method, replays an API call operation and advances the replay
     * cursor. Do not use unless you know exactly what you are doing.
     */
    _replayApi(method: string): Promise<NonNullable<ApiOp["r"]>> {
        let index = this.replayIndex.api?.get(method);
        if (index === undefined) {
            index = 0;
            this.replayIndex.api ??= new Map();
            this.replayIndex.api.set(method, index);
        }
        const result =
            this.opLog.u[this.replayIndex.wait - 1].a?.[method][index];
        this.replayIndex.api?.set(method, 1 + index);
        if (result === undefined) {
            return new Promise<never>(() => {});
        }
        return this._resolveAt(result.i, result.r);
    }

    /**
     * Internal method, replays an external operation and advances the replay
     * cursor. Do not use unless you know exactly what you are doing.
     */
    _replayExt(): Promise<NonNullable<ExtOp["r"]>> {
        let index = this.replayIndex.ext;
        if (index === undefined) this.replayIndex.ext = index = 0;
        const result = this.opLog.u[this.replayIndex.wait].e?.[index];
        this.replayIndex.ext = 1 + index;
        if (result === undefined) return new Promise<never>(() => {});
        return this._resolveAt(result.i, result.r);
    }
    /**
     * Internal method, logs a wait call. Do not use unless you know exactly
     * what you are doing.
     */
    _logWait(op: WaitOp) {
        if (!this._isReplaying) this.replayIndex.wait++;
        this.opLog.u.push(op);
    }
    /**
     * Internal method, unlogs the most recent call. Do not use unless you know
     * exactly what you are doing.
     */
    _unlogWait() {
        const op = this.opLog.u.pop();
        if (op === undefined) throw new Error("Empty log, cannot unlog!");
        if (!this._isReplaying) this.replayIndex.wait--;
        return op;
    }
    /**
     * Internal method, logs an API call and returns the assigned slot. Do not
     * use unless you know exactly what you are doing.
     */
    _logApi(method: string): ApiOp {
        const index = this.replayIndex.wait;
        const slot = { i: -1 };
        ((this.opLog.u[index - 1].a ??= {})[method] ??= []).push(slot);
        return slot;
    }
    /**
     * Internal method, logs an external operation and returns the assigned
     * slot. Do not use unless you know exactly what you are doing.
     */
    _logExt(): ExtOp {
        const index = this.replayIndex.wait;
        const slot = { i: -1 };
        (this.opLog.u[index - 1].e ??= []).push(slot);
        return slot;
    }
    /**
     * Internal method, finalizes a previously generated slot. Do not use unless
     * you know exactly what you are doing.
     */
    _finalize(slot: AsyncOrder) {
        slot.i = this.replayIndex.resolve ??= 0;
        this.replayIndex.resolve++;
    }
    /**
     * Internal method, creates a promise from a given value that will resolve
     * at the given index in order to accurately restore the order in which
     * different operations complete. Do not use unless you know exactly what
     * you are doing.
     */
    _resolveAt<T>(index: number, value?: T): Promise<T> {
        const r = resolver(value);
        if (index < 0) return r.promise;
        (this.replayIndex.tasks ??= [])[index] = r;
        const resolveNext = () => {
            if (this.replayIndex.tasks === undefined) return;
            this.replayIndex.resolve ??= 0;
            if (
                this.replayIndex.tasks[this.replayIndex.resolve] !== undefined
            ) {
                this.replayIndex.tasks[this.replayIndex.resolve].resolve();
                this.replayIndex.resolve++;
                setTimeout(resolveNext, 0);
            }
        };
        setTimeout(resolveNext, 0);
        return r.promise;
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) from the
     * user. Once received, this method returns the new context object for the
     * incoming update.
     */
    async wait(): Promise<C> {
        // If this is an old wait, simply return the old context object
        if (this._isReplaying) return this._replayWait();
        // Notify the resolver so that we can catch the function interception
        // and resume middleware execution normally outside of the conversation
        this.rsr.resolve("wait");
        // Intercept function execution
        await new Promise<never>(() => {}); // BOOM
        // deno-lint-ignore no-explicit-any
        return 0 as any; // dead code
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc)  that
     * fulfils a certain condition. This condition is specified via the given
     * predicate function. As soon as an update arrives for which the predicate
     * function returns `true`, this method will return it.
     *
     * @param predicate Condition to fulfil
     * @param otherwise Optional handler for discarded updates
     */
    async waitUntil<D extends C>(
        predicate: (ctx: C) => ctx is D,
        otherwise?: (ctx: C) => unknown | Promise<unknown>,
    ): Promise<D>;
    async waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        otherwise?: (ctx: C) => unknown | Promise<unknown>,
    ): Promise<C>;
    async waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        otherwise?: (ctx: C) => unknown | Promise<unknown>,
    ): Promise<C> {
        const ctx = await this.wait();
        if (!await predicate(ctx)) {
            await otherwise?.(ctx);
            await this.skip();
        }
        return ctx;
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) that does
     * not fulfil a certain condition. This condition is specified via the given
     * predicate function. As soon as an update arrives for which the predicate
     * function returns `false`, this method will return it.
     *
     * @param predicate Condition not to fulfil
     * @param otherwise Optional handler for discarded updates
     */
    async waitUnless(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        otherwise?: (ctx: C) => unknown | Promise<unknown>,
    ): Promise<C> {
        return await this.waitUntil(
            async (ctx) => !await predicate(ctx),
            otherwise,
        );
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) that matches
     * the given filter query. As soon as an update arrives that matches the
     * filter query, the corresponding context object is returned.
     *
     * @param query The filter query to check
     * @param otherwise Optional handler for discarded updates
     */
    async waitFor<Q extends FilterQuery>(
        query: Q | Q[],
        otherwise?: (ctx: C) => unknown | Promise<unknown>,
    ): Promise<Filter<C, Q>> {
        return await this.waitUntil(Context.has.filterQuery(query), otherwise);
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) from the
     * given user. As soon as an update arrives from this user, the
     * corresponding context object is returned.
     *
     * @param user The user to wait for
     * @param otherwise Optional handler for discarded updates
     */
    async waitFrom(
        user: number | User,
        otherwise?: (ctx: C) => unknown | Promise<unknown>,
    ): Promise<C & { from: User }> {
        const id = typeof user === "number" ? user : user.id;
        const predicate = (ctx: C): ctx is C & { from: User } =>
            ctx.from?.id === id;
        return await this.waitUntil(predicate, otherwise);
    }

    // TODO: implement command matching
    // TODO: implement hears matching
    // TODO: implement callback, game, and inline query matching

    /**
     * Utilities for building forms. Contains methods that let you wait for
     * messages and automatically perform input validation.
     */
    form = new ConversationForm(this);

    /**
     * Skips handling the update that was received in the last `wait` call. Once
     * called, the conversation resets to the last `wait` call, as if the update
     * had never been received. The control flow is passed on immediately, so
     * that middleware downstream of the conversation can continue handling the
     * update.
     *
     * Effectively, calling `await conversation.skip()` behaves as if this
     * conversation had not received the update at all.
     *
     * While the conversation rewinds its logs internally, it does not unsend
     * messages that you send between the calls to `wait` and `skip`.
     */
    async skip() {
        // We decided not to handle this update, so we purge the last wait
        // operation again. It also contains the log of all operations performed
        // since that wait. Hence, we effectively completely rewind the
        // conversation until before the update was received.
        this._unlogWait();
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
            const result = await this._replayExt();
            if ("v" in result) return await afterLoad(result.v);
            else throw await afterLoadError(result.e);
        }
        // Otherwise, execute the task and log its result
        const slot = this._logExt();
        try {
            const result = await task(...args);
            const value = await beforeStore(result);
            slot.r = { v: value };
            return result;
        } catch (error) {
            const value = await beforeStoreError(error);
            slot.r = { e: value };
            throw error;
        } finally {
            this._finalize(slot);
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
