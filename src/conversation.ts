import {
    type ApiResponse,
    type CallbackQueryContext,
    type CommandContext,
    Composer,
    Context,
    delistify,
    type Filter,
    type FilterQuery,
    type GameQueryContext,
    GLOBAL_CONSTRUCTOR_MAP,
    GrammyError,
    type HearsContext,
    HttpError,
    type LazySessionFlavor,
    listify,
    type Middleware,
    type MiddlewareFn,
    type RawApi,
    type SessionFlavor,
    type Update,
    type User,
} from "./deps.deno.ts";
import { ConversationForm } from "./form.ts";
import {
    clone,
    ident,
    IS_NOT_INTRINSIC,
    type Resolver,
    resolver,
} from "./utils.ts";
type MaybeArray<T> = T | T[];
// deno-lint-ignore ban-types
type StringWithSuggestions<S extends string> = (string & {}) | S;

/**
 * A user-defined conversation builder function that can be turned into
 * middleware for a conversation. This is the type of the function that you
 * should use to write your conversation. It can be used like so:
 *
 * ```ts
 * const myConversation: ConversationFn<MyContext> = async (conversation, ctx) => {
 *   // TODO define the conversation
 * }
 * ```
 *
 * The first parameter is the conversation handle which you can use to wait for
 * new messages, use forms, and access utilies such as random number generation.
 *
 * The second parameter is the initial context object. In this parameter, the
 * conversation builder function will receive the context object that was
 * received when the conversation was started.
 */
export type ConversationFn<C extends Context> = (
    conversation: Conversation<C>,
    ctx: C,
) => unknown | Promise<unknown>;
/**
 * Context flavor for the conversations plugin. Adds the conversation control
 * panel `ctx.conversation` which e.g. allows entering a conversation. It also
 * adds some properties to the session which the conversation plugin needs.
 */
export type ConversationFlavor<C extends Context | undefined = undefined> =
    & { conversation: ConversationControls }
    & (C extends Context
        // workaround for https://github.com/microsoft/TypeScript/issues/51111
        ? C extends LazySessionFlavor<infer V> ? 
                & Omit<C, "session">
                & LazySessionFlavor<ConversationSessionData & V>
        : 
            & C
            & SessionFlavor<ConversationSessionData>
        // TODO: remove additive flavor for 2.0
        : 
            | SessionFlavor<ConversationSessionData>
            | LazySessionFlavor<ConversationSessionData>);

interface Internals {
    /** Known conversation identifiers, used for collision checking */
    ids: Set<string>;
    /** Session data supplier, used to persist conversation state */
    session: () => Promise<ConversationSessionData>;
}

const KNOWN_TYPES = new Map(GLOBAL_CONSTRUCTOR_MAP);
const e = KNOWN_TYPES.get(Error.name);
KNOWN_TYPES.delete(Error.name);
KNOWN_TYPES.set(GrammyError.name, {
    instance: GrammyError as unknown as new () => GrammyError,
    from: (err: GrammyError) => {
        const res: unknown[] = [
            err.message,
            err.error_code,
            err.description,
            err.parameters,
            err.method,
            err.payload,
        ];
        if (err.stack !== undefined) res.push(err.stack);
        if (err.cause !== undefined) {
            if (err.stack === undefined) res.push(undefined);
            res.push(err.cause);
        }
        return res;
    },
    create: (
        [
            message,
            error_code,
            description,
            parameters,
            method,
            payload,
            stack,
            cause,
        ],
    ) => {
        const err = new GrammyError(
            message,
            { ok: false, error_code, description, parameters },
            method,
            payload,
        );
        if (stack === undefined) delete err.stack;
        else err.stack = stack;
        if (cause !== undefined) err.cause = cause;
        return err;
    },
});
KNOWN_TYPES.set(HttpError.name, {
    instance: HttpError as unknown as new () => HttpError,
    from: (err: HttpError) => {
        const res: unknown[] = [err.message, err.error];
        if (err.stack !== undefined) res.push(err.stack);
        if (err.cause !== undefined) {
            if (err.stack === undefined) res.push(undefined);
            res.push(err.cause);
        }
        return res;
    },
    create: ([message, error, stack, cause]) => {
        const err = new HttpError(message, error);
        if (stack === undefined) delete err.stack;
        else err.stack = stack;
        if (cause !== undefined) err.cause = cause;
        return err;
    },
});
if (e !== undefined) KNOWN_TYPES.set(Error.name, e);

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
    readonly [internal]: Internals;

    constructor(
        session: () => Promise<ConversationSessionData>,
    ) {
        this[internal] = { ids: new Set(), session };
    }

    /**
     * Returns a map of the identifiers of currently active conversations to the
     * number of times this conversation is active in the current chat. For
     * example, you can use `"captcha" in ctx.conversation.active` to check if
     * there are any active conversations in this chat with the identifier
     * `"captcha"`.
     */
    async active() {
        return Object.fromEntries(
            Object.entries((await this[internal].session()).conversation ?? {})
                .map(([id, conversations]) => [id, conversations.length]),
        );
    }

    /**
     * Enters a conversation with the given identifier.
     *
     * Note that this method is async. You must `await` this method.
     *
     * While it is possible to enter a conversation from within another
     * conversation in order to start a parallel conversation, it is usually
     * preferable to simply call the other conversation function directly:
     * https://grammy.dev/plugins/conversations.html#functions-and-recursion
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
     *
     * While it is possible to reenter a conversation from within another
     * conversation in order to start a parallel conversation, it is usually
     * preferable to simply call the other conversation function directly:
     * https://grammy.dev/plugins/conversations.html#functions-and-recursion
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
     *
     * Note that if you call `exit` from within a conversation, the conversation
     * will not terminate immediately once it reaches the `exit` call. Instead,
     * it will continue until it reaches the next `wait` or `skip` statement,
     * and then exit. This is another reason why it is usually easier to return
     * or throw in order to leave a conversation.
     */
    public async exit(id?: string) {
        const session = await this[internal].session();
        if (session.conversation == undefined) return;
        if (id === undefined) {
            // Simply clear all conversation data
            session.conversation = undefined;
        } else {
            // Strip out specified conversations from active ones
            delete session.conversation[id];
            // Do not store empty object
            if (Object.keys(session.conversation).length === 0) {
                session.conversation = undefined;
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
    /**
     * Time in milliseconds since The Epoch which describes that last time the
     * conversation builder function was advanced. Used to implement timeouts.
     */
    last?: number;
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

/**
 * Ops that can lead to interruption of function execution.
 *
 * - wait: conversation advanced, rerun it with next update (consumed: true, exit: false)
 * - skip: skip this conversation, run next one (consumed: false, exit: false)
 * - timeout: conversation timed out, exit it and then `skip` (consumed: false, exit: true)
 * - done: conversation finished normally, exit it (consumed: true, exit: true)
 */
interface ResolveOps {
    /** Has the conversation consumed the update? */
    consumed: boolean;
    /** Should this conversation be exited? */
    exit: boolean;
}

/**
 * Creates a runner function which is in turn able to execute conversation
 * builder functions based on an op log.
 */
function conversationRunner<C extends Context>(
    ctx: C & ConversationFlavor,
    builder: ConversationFn<C>,
    timeout: number | undefined,
) {
    /**
     * Adds an entry for the current context object to the given log,
     * effectively turning the most recent wait op into a old wait which will be
     * replayed
     */
    function waitOp(): WaitOp {
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
        return { u: ctx.update, x: extra, f: functions };
    }

    /**
     * Defines how to run a conversation builder function. Returns `false` if
     * the conversation decided to pass on the control flow, and `true` if it
     * handled the update, i.e. completed normally or via a wait call. Note that
     * this function re-throws errors thrown by the conversation.
     */
    async function run(data: ActiveConversation): Promise<ResolveOps> {
        // Create the conversation handle
        const rsr = resolver<ResolveOps>(); // used to catch `wait` calls
        const handle = new ConversationHandle<C>(ctx, data, rsr, timeout);
        // We are either starting the conversation builder function from
        // scratch, or we are beginning a replay operation. In both cases, the
        // current context object is new to the conversation builder function,
        // be it the inital context object or the result of a `wait` call.
        // Hence, we should log an op with the current context object.
        handle._logWait(waitOp()); // appends to end of log
        // Now, we invoke the conversation builder function. We start by
        // replaying the initial context object manually.
        const initialContext = await handle._replayWait(); // retrieves from start of log
        // Call the target builder function supplied by the user, but don't
        // blindly await it because when `wait` is called somewhere inside,
        // execution is aborted. The `Promise.race` intercepts this again and
        // allows us to resume normal middleware handling.
        try {
            await Promise.race([rsr.promise, builder(handle, initialContext)]);
        } finally {
            handle._deactivate();
        }
        return rsr.value ?? { consumed: true, exit: true };
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
    C & ConversationFlavor
> {
    return async (ctx, next) => {
        if (!("session" in ctx)) {
            throw new Error("Cannot use conversations without session!");
        }
        let transformed = false;
        ctx.conversation ??= new ConversationControls(async () => {
            // Access session lazily
            const session = await ctx.session;
            if (!transformed) {
                transformed = true;
                if (
                    typeof session.conversation === "number" ||
                    (typeof session.conversation === "object" &&
                        Array.isArray(session.conversation))
                ) {
                    session.conversation = delistify(
                        session.conversation,
                        KNOWN_TYPES,
                    );
                }
            }
            return session;
        });
        await next();
        if (transformed) {
            const session = await ctx.session;
            if (session.conversation != undefined) {
                session.conversation = listify(
                    session.conversation,
                    KNOWN_TYPES,
                    // deno-lint-ignore no-explicit-any
                ) as any;
            }
        }
    };
}

/**
 * Configuration options that can be passed when using `createConversation` to
 * turn a conversation builder function into middleware.
 */
export interface ConversationConfig {
    /**
     * Identifier of the conversation which can be used to enter it. Defaults to
     * the name of the function.
     */
    id?: string;
    /**
     * Maximum number of milliseconds to wait. If an update is received after
     * this time has elapsed, the conversation will be left automatically
     * instead of resuming, and the update will be handled as if the
     * conversation had not been active.
     *
     * This is the default value that each conversation with this identifier
     * starts with. Note that you can override this value for a specific run of
     * the conversation when calling `ctx.conversation.enter`. In addition, you
     * can adjust this value from within a conversation between wait calls by
     * assigning a new value to `conversation.millisecondsToWait`.
     */
    maxMillisecondsToWait?: number;
}

/**
 * Takes a conversation builder function, and turns it into grammY middleware
 * which can be installed on your bot. Check out the
 * [documentation](https://grammy.dev/plugins/conversations.html) to learn more
 * about how conversation builder functions can be created.
 *
 * @param builder Conversation builder function
 * @param config Identifier of the conversation or configuration object
 * @returns Middleware to be installed on the bot
 */
export function createConversation<C extends Context>(
    builder: ConversationFn<C>,
    config: string | ConversationConfig = {},
): MiddlewareFn<C & ConversationFlavor> {
    const { id = builder.name, maxMillisecondsToWait }: ConversationConfig =
        typeof config === "string" ? { id: config } : config;
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
        const runOnData = conversationRunner(
            ctx,
            builder,
            maxMillisecondsToWait,
        );

        /**
         * Runs our conversation builder function for all given logs in
         * ascending order until the first decides to handle the update.
         */
        async function runUntilComplete(conversations: ActiveConversation[]) {
            let op: ResolveOps = { consumed: false, exit: false };
            for (let i = 0; !op.consumed && i < conversations.length; i++) {
                const current = conversations[i];
                try {
                    op = await runOnData(current);
                } catch (e) {
                    conversations.splice(i, 1);
                    throw e;
                }
                if (op.exit) conversations.splice(i--, 1);
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
            const session = await ctx.conversation[internal].session();
            session.conversation ??= {};
            const entry: ActiveConversation = {
                log: { u: [] },
                last: Date.now(),
            };
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

        const session = await ctx.conversation[internal].session();
        try {
            // Run all existing conversations with our identifier
            let op: ResolveOps = { consumed: false, exit: false };
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
            if (!op.consumed) await next();
        } finally {
            // Clean up if no conversations remain
            if (
                session.conversation != undefined &&
                Object.keys(session.conversation).length === 0
            ) {
                session.conversation = undefined;
            }
        }
    };
}

/**
 * Handler for a context object that will be invoked when a condition fails.
 */
export type OtherwiseHandler<C extends Context> = (
    ctx: C,
) => unknown | Promise<unknown>;
/**
 * Options object with settings that determine how to handle a failing
 * condition.
 */
export interface OtherwiseOptions<C extends Context> {
    drop?: boolean;
    maxMilliseconds?: number;
    otherwise?: OtherwiseHandler<C>;
}
/**
 * Configuration for how to handle a failing condition, either a function or an
 * options object.
 */
export type OtherwiseConfig<C extends Context> =
    | OtherwiseHandler<C>
    | OtherwiseOptions<C>;
function toObj<C extends Context>(
    otherwise?: OtherwiseConfig<C>,
): OtherwiseOptions<C> {
    return typeof otherwise === "function" ? { otherwise } : otherwise ?? {};
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
    private currentCtx?: C;
    private active = true;
    private mw = new Composer<C>();

    constructor(
        private readonly ctx: C,
        private readonly data: ActiveConversation,
        private readonly rsr: Resolver<ResolveOps>,
        private readonly timeout: number | undefined,
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
        return this.replayIndex.wait < this.data.log.u.length;
    }
    /**
     * Internal method, replays a wait operation and advances the replay cursor.
     * Do not use unless you know exactly what you are doing.
     */
    async _replayWait(): Promise<C> {
        if (!this._isReplaying) {
            throw new Error(
                "Replay stack exhausted, you may not call this method!",
            );
        }
        const { u, x, f = [] } = this.data.log.u[this.replayIndex.wait];
        this.replayIndex = { wait: 1 + this.replayIndex.wait };
        let ctx: C;
        if (!this._isReplaying) {
            // Return original context if we're about to resume execution
            ctx = this.ctx;
        } else {
            // Create fake context, and restore all enumerable properties
            ctx = Object.assign(
                new Context(u, this.ctx.api, this.ctx.me),
                x,
            ) as C;
            // Copy over functions which we could not store
            f.forEach((key) => {
                // deno-lint-ignore no-explicit-any
                const current = (this.ctx as any)[key];
                if (typeof current === "function") {
                    // deno-lint-ignore no-explicit-any
                    (ctx as any)[key] = current.bind(this.ctx);
                }
            });
        }
        this.currentCtx = ctx;
        await runAsLeaf(ctx, this.mw);
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
            this.data.log.u[this.replayIndex.wait - 1].a?.[method][index];
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
        const result = this.data.log.u[this.replayIndex.wait - 1].e?.[index];
        this.replayIndex.ext = 1 + index;
        if (result === undefined) return new Promise<never>(() => {});
        return this._resolveAt(result.i, result.r);
    }
    /**
     * Internal method, logs a wait call. Do not use unless you know exactly
     * what you are doing.
     */
    _logWait(op: WaitOp) {
        this.data.log.u.push(op);
    }
    /**
     * Internal method, unlogs the most recent call. Do not use unless you know
     * exactly what you are doing.
     */
    _unlogWait() {
        const op = this.data.log.u.pop();
        if (op === undefined) throw new Error("Empty log, cannot unlog!");
        return op;
    }
    /**
     * Internal method, logs an API call and returns the assigned slot. Do not
     * use unless you know exactly what you are doing.
     */
    _logApi(method: string): ApiOp {
        const index = this.replayIndex.wait;
        const slot = { i: -1 };
        ((this.data.log.u[index - 1].a ??= {})[method] ??= []).push(slot);
        return slot;
    }
    /**
     * Internal method, logs an external operation and returns the assigned
     * slot. Do not use unless you know exactly what you are doing.
     */
    _logExt(): ExtOp {
        const index = this.replayIndex.wait;
        const slot = { i: -1 };
        (this.data.log.u[index - 1].e ??= []).push(slot);
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
    async wait(
        opts: { maxMilliseconds?: number } = { maxMilliseconds: this.timeout },
    ): Promise<C> {
        // If this is an old wait, simply return the old context object
        if (this._isReplaying) {
            const ctx = await this._replayWait();
            // Exit the conversation if the wait expired
            const timeout = opts.maxMilliseconds;
            if (
                !this._isReplaying && // limit to the current wait
                this.data.last !== undefined &&
                timeout !== undefined &&
                this.data.last + timeout < Date.now()
            ) {
                // conversation expired, leave it
                this.rsr.resolve({ consumed: false, exit: true });
                await new Promise<never>(() => {});
            }
            return ctx;
        }
        // Notify the resolver so that we can catch the function interception
        // and resume middleware execution normally outside of the conversation
        this.rsr.resolve({ consumed: true, exit: false });
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
     * @param opts Optional config for discarded updates
     */
    async waitUntil<D extends C>(
        predicate: (ctx: C) => ctx is D,
        opts?: OtherwiseConfig<C>,
    ): Promise<D>;
    async waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: OtherwiseConfig<C>,
    ): Promise<C>;
    async waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: OtherwiseConfig<C>,
    ): Promise<C> {
        const { otherwise, drop, maxMilliseconds } = toObj(opts);
        const ctx = await this.wait({ maxMilliseconds });
        if (!await predicate(ctx)) {
            await otherwise?.(ctx);
            await this.skip({ drop });
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
     * @param opts Optional config for discarded updates
     */
    async waitUnless(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: OtherwiseConfig<C>,
    ): Promise<C> {
        return await this.waitUntil(async (ctx) => !await predicate(ctx), opts);
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) that matches
     * the given filter query. As soon as an update arrives that matches the
     * filter query, the corresponding context object is returned.
     *
     * @param query The filter query to check
     * @param opts Optional config for discarded updates
     */
    async waitFor<Q extends FilterQuery>(
        query: Q | Q[],
        opts?: OtherwiseConfig<C>,
    ): Promise<Filter<C, Q>> {
        return await this.waitUntil(Context.has.filterQuery(query), opts);
    }

    /**
     * Waits for a new message or channel post that contains the given text, or
     * that contains text which matches the given regular expression. This uses
     * the same logic as `bot.hears`.
     *
     * @param trigger The string or regex to match
     * @param opts Optional config for discarded updates
     */
    async waitForHears(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseConfig<C>,
    ): Promise<HearsContext<C>> {
        return await this.waitUntil(Context.has.text(trigger), opts);
    }

    /**
     * Waits for the specified command. This uses the same logic as
     * `bot.command`.
     *
     * @param command The command to match
     * @param opts Optional config for discarded updates
     */
    async waitForCommand<S extends string>(
        command: MaybeArray<
            StringWithSuggestions<S | "start" | "help" | "settings">
        >,
        opts?: OtherwiseConfig<C>,
    ): Promise<CommandContext<C>> {
        return await this.waitUntil(Context.has.command(command), opts);
    }

    /**
     * Waits for an update which contains the given callback query, or for the
     * callback query data to match the given regular expression. This uses the
     * same logic as `bot.callbackQuery`.
     *
     * @param trigger The string or regex to match
     * @param opts Optional config for discarded updates
     */
    async waitForCallbackQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseConfig<C>,
    ): Promise<CallbackQueryContext<C>> {
        return await this.waitUntil(Context.has.callbackQuery(trigger), opts);
    }

    /**
     * Waits for an update which contains the given game query, or for the
     * game query data to match the given regular expression. This uses the
     * same logic as `bot.gameQuery`.
     *
     * @param trigger The string or regex to match
     * @param opts Optional config for discarded updates
     */
    async waitForGameQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseConfig<C>,
    ): Promise<GameQueryContext<C>> {
        return await this.waitUntil(Context.has.gameQuery(trigger), opts);
    }

    /**
     * Waits for a new update (e.g. a message, callback query, etc) from the
     * given user. As soon as an update arrives from this user, the
     * corresponding context object is returned.
     *
     * @param user The user to wait for
     * @param opts Optional config for discarded updates
     */
    async waitFrom(
        user: number | User,
        opts?: OtherwiseConfig<C>,
    ): Promise<C & { from: User }> {
        const id = typeof user === "number" ? user : user.id;
        const predicate = (ctx: C): ctx is C & { from: User } =>
            ctx.from?.id === id;
        return await this.waitUntil(predicate, opts);
    }

    /**
     * Waits for a new message or channel post which replies to the specified
     * message. As soon as an update arrives that contains such a message or
     * channel post, the corresponding context object is returned.
     *
     * @param message_id The message to which to reply
     * @param opts Optional config for discarded updates
     */
    async waitForReplyTo(
        message_id: number | { message_id: number },
        opts?: OtherwiseConfig<C>,
    ): Promise<Filter<C, "message" | "channel_post">> {
        const id = typeof message_id === "number"
            ? message_id
            : message_id.message_id;
        return await this.waitUntil(
            (ctx): ctx is Filter<C, "message" | "channel_post"> =>
                ctx.message?.reply_to_message?.message_id === id ||
                ctx.channelPost?.reply_to_message?.message_id === id,
            opts,
        );
    }

    /**
     * Utilities for building forms. Contains methods that let you wait for
     * messages and automatically perform input validation.
     */
    form = new ConversationForm(this);

    /**
     * Skips handling the update that was received in the last `wait` call. Once
     * called, the conversation resets to the last `wait` call, as if the update
     * had never been received. Unless `{ drop: true }` is passed, the control
     * flow is passed on immediately, so that middleware downstream of the
     * conversation can continue handling the update.
     *
     * Effectively, calling `await conversation.skip()` behaves as if this
     * conversation had not received the update at all.
     *
     * While the conversation rewinds its logs internally, it does not unsend
     * messages that you send between the calls to `wait` and `skip`.
     */
    async skip(opts: { drop?: boolean } = {}) {
        const { drop = false } = opts;
        // We decided not to handle this update, so we purge the last wait
        // operation again. It also contains the log of all operations performed
        // since that wait. Hence, we effectively completely rewind the
        // conversation until before the update was received.
        this._unlogWait();
        // Notify the resolver so that we can catch the function interception
        // and resume middleware execution normally outside of the conversation
        this.rsr.resolve({ consumed: drop, exit: false });
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
            beforeStore?: (value: Awaited<ReturnType<F>>) => I | Promise<I>;
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
     * Safe alias for `ctx.session`. Use this instead of `ctx.session` when
     * inside a conversation.
     *
     * As you call `conversation.wait` several times throughout the
     * conversation, your session data may evolve. The conversations plugin
     * makes sure to track these changes so that your conversation can work
     * correctly each time it is run. This means that there are several
     * snapshots of the session throughout time which all co-exist. It can be
     * cumbersome to always make sure to use the correct session so that the
     * code does not alter history (this would lead to data loss). You should
     * use this helper type to make sure you are accessing the correct session
     * object at all times.
     */
    // deno-lint-ignore no-explicit-any
    get session(): C extends { session: any } ? C["session"] : never {
        if (this.currentCtx === undefined) throw new Error("No context!");
        const ctx: C & {
            // deno-lint-ignore no-explicit-any
            session?: C extends { session: any } ? C["session"] : never;
        } = this.currentCtx;
        if (ctx.session === undefined) {
            throw new Error("Session is missing!");
        }
        return ctx.session;
    }
    set session(
        // deno-lint-ignore no-explicit-any
        value: C extends { session: any } ? C["session"] | undefined : never,
    ) {
        if (this.currentCtx === undefined) throw new Error("No context!");
        const ctx: C & {
            // deno-lint-ignore no-explicit-any
            session?: C extends { session: any } ? C["session"] : never;
        } = this.currentCtx;
        ctx.session = value;
    }
    /**
     * > This method is rarely useful because it freezes your bot and that's
     * > most likely not actually what you want to do. Consider using one of the
     * > variants of `wait` instead.
     *
     * Freezes your bot for the specified number of milliseconds. The current
     * middleware execution will simply stop for a while. Note that if you're
     * processing updates concurrently (with grammY runner) then unrelated
     * updates will still be handled in the meantime. Note further that sleeping
     * during webhooks is dangerous because [it can lead to duplicate
     * updates](https://grammy.dev/guide/deployment-types.html#ending-webhook-requests-in-time).
     *
     * You should use this instead of your own sleeping function so that you
     * don't block the conversation while it is restoring a previous position.
     *
     * @param milliseconds The number of milliseconds to sleep
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
     * @returns A random number as generated by `Math.random()`
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
        if (this._isReplaying) return;
        console.log(...args);
    }
    /**
     * Safely perform `console.error` calls, but only when they should really be
     * logged (so not during replay operations).
     *
     * @param args Arguments to pass to `console.error`
     */
    error(...args: Parameters<typeof console.error>) {
        if (this._isReplaying) return;
        console.error(...args);
    }
    /**
     * Safely gets the value of `Date.now()`. You should use this instead of
     * `Date.now()` in your conversation because the time value changes
     * continuously, which may lead to unpredictable and non-deterministic
     * behavior.
     *
     * @returns The value of `Date.now()`
     */
    now() {
        return this.external({ task: () => Date.now() });
    }
    /**
     * Runs a piece of middleware for each already received context object every
     * time a context object is received. This can be used to install plugins
     * inside conversations.
     *
     * For instance, if three context objects arrive, this is what happens:
     *
     * 1. the first update is received
     * 2. the middleware runs for the first update
     * 3. the second update is received
     * 4. the middleware runs for the first update
     * 5. the middleware runs for the second update
     * 6. the third update is received
     * 7. the middleware runs for the first update
     * 8. the middleware runs for the second update
     * 9. the middleware runs for the third update
     *
     * Note that the middleware is run with first update thrice.
     *
     * @param middleware The middleware to run
     */
    async run(...middleware: Middleware<C>[]) {
        if (this.currentCtx === undefined) throw new Error("No context!");
        await runAsLeaf(this.currentCtx, ...middleware);
        this.mw.use(async (ctx, next) => {
            if (await runAsLeaf(ctx, ...middleware)) await next();
        });
    }
}

async function runAsLeaf<C extends Context>(
    ctx: C,
    ...middleware: Middleware<C>[]
) {
    const mw = new Composer(...middleware).middleware();
    let nextCalled = false;
    await mw(ctx, () => (nextCalled = true, Promise.resolve()));
    return nextCalled;
}
