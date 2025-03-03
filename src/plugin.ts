import { Conversation } from "./conversation.ts";
import {
    Api,
    type ApiClientOptions,
    Composer,
    Context,
    HttpError,
    type Middleware,
    type MiddlewareFn,
    type Update,
    type UserFromGetMe,
} from "./deps.deno.ts";
import {
    type Checkpoint,
    type ReplayControls,
    ReplayEngine,
    type ReplayState,
} from "./engine.ts";
import { youTouchYouDie } from "./nope.ts";
import { type ConversationStorage, uniformStorage } from "./storage.ts";

const internalRecursionDetection = Symbol("conversations.recursion");
const internalState = Symbol("conversations.state");
const internalCompletenessMarker = Symbol("conversations.completeness");

interface InternalState<OC extends Context, C extends Context> {
    getMutableData(): ConversationData;
    index: ConversationIndex<OC, C>;
    defaultPlugins: Middleware<C>[];
    exitHandler?(name: string): Promise<void>;
}

/**
 * Base data that is needed to enter or resume a conversation function. Contains
 * a subset of properties from the current context object of the outside
 * middleware tree.
 *
 * The contained update is supplied as the new update for the most recent wait
 * call.
 */
export interface ContextBaseData {
    /** The new update to supply to the conversation */
    update: Update;
    /** Basic information used to construct `Api` instances */
    api: ApiBaseData;
    /** Information about the bot itself. */
    me: UserFromGetMe;
}
/**
 * Base data that is needed to construct new `Api` instances from scratch.
 * Contains a subset of properties from `ctx.api` from the outside middleware
 * tree.
 */
export interface ApiBaseData {
    /** The bot's token obtained from [@BotFather](https://t.me/BotFather) */
    token: string;
    /** Optional confiugration options for the underlying API client */
    options?: ApiClientOptions;
}

/**
 * Optional configuration options for the conversations plugin.
 *
 * Note that this configuration object takes two different types of custom
 * context types. The first type parameter should corresopnd with the context
 * type of the outside middleware tree. It is used to connect to external
 * storages.
 *
 * The second type parameter should correspond with the custom context type used
 * inside all conversations. It is used if you define a list of default plugins
 * to be installed in every conversation you use. If the list of plugins differs
 * between conversations, you may want to use different context types for them.
 * In that case, you should use a context type for only those plugins that are
 * shared between all conversations, or avoid a list of default plugins
 * entirely.
 *
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside conversations
 */
export interface ConversationOptions<OC extends Context, C extends Context> {
    /**
     * Defines how to persist and version conversation data in between replays.
     * Most likely, you will want to use this option, as your data is lost
     * otherwise.
     *
     * Data can be stored based on a context object, or based on a key derived
     * from the context object. See {@link ConversationStorage} for more
     * information.
     *
     * Defaults to an in-memory implementation of the storage. This means that
     * all conversations will be left when your process terminates.
     *
     * Defaults to storing data per chat based on `ctx.chatId`.
     */
    storage?: ConversationStorage<OC, ConversationData>;
    /**
     * List of default plugins to install for all conversations.
     *
     * Each conversation will have these plugins installed first. In addition,
     * each conversation will have the plugins installed that you specify
     * explicitly when using {@link enterConversation}.
     */
    plugins?: Middleware<C>[];
    /**
     * Called when a conversation is entered via `ctx.conversation.enter`.
     *
     * @param id The identifer of the conversation that was entered
     * @param ctx The current context object
     */
    onEnter?(id: string, ctx: OC): unknown | Promise<unknown>;
    /**
     * Called when a conversation is left via `ctx.conversation.exit` or
     * `conversation.halt`.
     *
     * Note that this callback is not called when a conversation exits normally
     * by returning or by throwing an error. If you wish to execute logic at the
     * end of a conversation, you can simply call the callback directly.
     *
     * @param id The identifer of the conversation that was entered
     * @param ctx The current context object
     */
    onExit?(id: string, ctx: OC): unknown | Promise<unknown>;
}
/**
 * Internal conversation data representation. Holds the state of any number of
 * conversations for each conversation identifier.
 */
export interface ConversationData {
    [id: string]: ConversationState[];
}
type ConversationIndex<OC extends Context, C extends Context> = Map<
    string,
    ConversationIndexEntry<OC, C>
>;
interface ConversationIndexEntry<OC extends Context, C extends Context> {
    builder: ConversationBuilder<OC, C>;
    plugins: Middleware<C>[];
    maxMillisecondsToWait: number | undefined;
    parallel: boolean;
}
/**
 * Context flavor for the outside middleware tree. Installs `ctx.conversation`
 * on the type of a context object so it can be used to enter or exit
 * conversations as well as inspect active conversations.
 *
 * This should only be installed if you install the {@link conversations}
 * middleware.
 *
 * Note that it is not possible to use the conversations plugin recursively
 * inside conversations. In other words `ctx.conversation` does not exist inside
 * a conversation. Consequently, it is always incorrect to install this context
 * flavor for context objects inside conversations.
 */
export type ConversationFlavor<C extends Context> = C & {
    /**
     * Controls for entering or exiting conversations from the outside
     * middleware. Also provides a way to inspect which conversations are
     * currently active.
     */
    conversation: ConversationControls;
};
/**
 * A control panel for all known conversations. This holds the `enter` method
 * that is the main entrypoint to a conversation.
 *
 * In addition, conversations can be killed from the outside using one of the
 * exit methods.
 *
 * Finally, the control panel can be used to inspect which conversations are
 * currently active.
 */
export interface ConversationControls {
    /**
     * Enters the conversation with the given identifer. By default, the name of
     * the function is the identifier of the function. You can override this
     * value when calling {@link createConversation}.
     *
     * ```ts
     * // Enters a conversation called "convo" upon a start command.
     * bot.command("start", async ctx => {
     *   await ctx.conversation.enter("convo")
     * })
     * ```
     *
     * Entering a conversation will make the conversation run partially until
     * the first wait call is reached. The enter call will therefore return long
     * before the conversation has returned.
     *
     * You can pass any number of arguments when entering a conversation. These
     * arguments will be serialized to JSON and persisted in the storage as
     * `string`. Whenever the conversation is replayed, this string is parsed
     * back to objects and supplied to the conversation. This means that all
     * arguments must be JSON-serializable.
     *
     * ```ts
     * // Enters a conversation called "convo" upon a start command.
     * bot.command("start", async ctx => {
     *   await ctx.conversation.enter("convo", 42, "cool", { args: [2, 1, 0] })
     * })
     * async function convo(conversation, ctx, num, str, { args }) {
     *   // ...
     * }
     * ```
     *
     * Be careful: There is no type safety for conversation arguments! You must
     * annotate the correct types in the function signature of the conversation
     * builder function, and you also have to make sure that you pass matching
     * values to `enter`.
     *
     * This method will throw an error if the same or a different conversation
     * has already been entered. If you want to enter a conversations in
     * parallel to existing active conversations, you can mark it as parallel.
     * This can be done by passig `{ parallel: true }` to
     * {@link createConversation}.
     *
     * @param name The identifer of the conversation to enter
     * @param args Optional list of arguments
     */
    enter(name: string, ...args: unknown[]): Promise<void>;
    /**
     * Purges all state of the conversation with the given identifer for the
     * current chat. This means that if the specified conversation had been
     * active, it is now terminated. If the conversation was marked as parallel,
     * all conversations with this identifier are left for the current chat.
     *
     * Note that if you call this method concurrently to a replay, the replay
     * will not be interrupted. However, its data will not be saved as soon as
     * the replay finishes.
     *
     * For every exited conversation, `onExit` will be called if specified when
     * installing the conversations plugin.
     *
     * Does nothing if no conversation with the given name is active in the
     * current chat.
     *
     * @param name The identifier of the conversation to exit
     */
    exit(name: string): Promise<void>;
    /**
     * Purges all state of all conversations in the current chat, irrespective
     * of their identifers. This will terminate all conversations.
     *
     * Note that if you call this method concurrently to a replay, the replay
     * will not be interrupted. However, its data will not be saved as soon as
     * the replay finishes.
     *
     * For every exited conversation, `onExit` will be called if specified when
     * installing the conversations plugin.
     *
     * Does nothing if no conversations are running.
     */
    exitAll(): Promise<void>;
    /**
     * Purges all state of the conversation with the given identifer at the
     * given position for the current chat. This means that if the specified
     * conversation had been active, it is now terminated. The position is
     * determined chronologically. For example, passing `0` will exit the oldest
     * parallel conversation with the given identifier that is still active.
     *
     * Note that if you call this method concurrently to a replay, the replay
     * will not be interrupted. However, its data will not be saved as soon as
     * the replay finishes.
     *
     * `onExit` will be called if specified when installing the conversations
     * plugin.
     *
     * Does nothing if no conversation with the given name is active at the
     * given position in the current chat.
     *
     * @param name The identifier of the conversation to exit
     * @param index The position of the conversation to exit
     */
    exitOne(name: string, index: number): Promise<void>;
    /**
     * Returns an object specifying the number of times that each conversation
     * is currently active. For example, if a parallel conversation called
     * "captcha" is active 3 times in the current chat, and a conversation
     * called "settings" is active once in the same chat, the returned object
     * will look like this.
     *
     * ```ts
     * {
     *   captcha: 3,
     *   settings: 1,
     * }
     * ```
     */
    active(): Record<string, number>;
    /**
     * Returns the number of times that a given conversation is active in the
     * current chat. If no conversation was marked as parallel, this value will
     * always only be either `0` or `1`.
     *
     * For example, this is how you can check if a conversation called
     * "birthday" is currently active.
     *
     * ```ts
     * if (ctx.conversation.active("birthday")) {
     *   // birthday conversation is active
     * }
     * // same but more explicit:
     * if (ctx.conversation.active("birthday") > 0) {
     *   // birthday conversation is active
     * }
     * ```
     *
     * @param name
     */
    active(name: string): number;
}
function controls(
    getData: () => ConversationData,
    isParallel: (name: string) => boolean,
    enter: (name: string, ...args: unknown[]) => Promise<EnterResult>,
    exit: ((name: string) => Promise<void>) | undefined,
    canSave: () => boolean,
): ConversationControls {
    async function fireExit(events: string[]) {
        if (exit === undefined) return;
        const len = events.length;
        for (let i = 0; i < len; i++) {
            await exit(events[i]);
        }
    }

    return {
        async enter(name, ...args) {
            if (!canSave()) {
                throw new Error(
                    "The middleware has already completed so it is \
no longer possible to enter a conversation",
                );
            }
            const data = getData();
            if (Object.keys(data).length > 0 && !isParallel(name)) {
                throw new Error(
                    `A conversation was already entered and '${name}' \
is not a parallel conversation. Make sure to exit all active conversations \
before entering a new one, or specify { parallel: true } for '${name}' \
if you want it to run in parallel.`,
                );
            }
            data[name] ??= [];
            const result = await enter(name, ...args);
            if (!canSave()) {
                throw new Error(
                    "The middleware has completed before conversation was fully \
entered so the conversations plugin cannot persist data anymore, did you forget \
to use `await`?",
                );
            }
            switch (result.status) {
                case "complete":
                    return;
                case "error":
                    throw result.error;
                case "handled":
                case "skipped": {
                    const args = result.args === undefined
                        ? {}
                        : { args: result.args };
                    const state: ConversationState = {
                        ...args,
                        interrupts: result.interrupts,
                        replay: result.replay,
                    };
                    data[name]?.push(state);
                    return;
                }
            }
        },
        async exitAll() {
            if (!canSave()) {
                throw new Error(
                    "The middleware has already completed so it is no longer possible to exit all conversations",
                );
            }
            const data = getData();
            const keys = Object.keys(data);
            const events = keys.flatMap((key) =>
                Array<string>(data[key].length).fill(key)
            );
            keys.forEach((key) => delete data[key]);
            await fireExit(events);
        },
        async exit(name) {
            if (!canSave()) {
                throw new Error(
                    `The middleware has already completed so it is no longer possible to exit any conversations named '${name}'`,
                );
            }
            const data = getData();
            if (data[name] === undefined) return;
            const events = Array<string>(data[name].length).fill(name);
            delete data[name];
            await fireExit(events);
        },
        async exitOne(name, index) {
            if (!canSave()) {
                throw new Error(
                    `The middleware has already completed so it is no longer possible to exit the conversation '${name}'`,
                );
            }
            const data = getData();
            if (
                data[name] === undefined ||
                index < 0 || data[name].length <= index
            ) return;
            data[name].splice(index, 1);
            await fireExit([name]);
        },
        // deno-lint-ignore no-explicit-any
        active(name?: string): any {
            const data = getData();
            return name === undefined
                ? Object.fromEntries(
                    Object.entries(data)
                        .map(([name, states]) => [name, states.length]),
                )
                : data[name]?.length ?? 0;
        },
    };
}

/**
 * Middleware for the conversations plugin.
 *
 * This is the main thing you have to install in order to use this plugin. It
 * performs various setup tasks for each context object, and it reads and writes
 * to the data storage if provided. This middleware has to be installed before
 * you can install `createConversation` with your conversation builder function.
 *
 * You can pass {@link ConversationOptions | an options object} to the plugin.
 * The most important option is called `storage`. It can be used to persist
 * conversations durably in any storage backend of your choice. That way, the
 * conversations can survive restarts of your server.
 *
 * ```ts
 * conversations({
 *   storage: {
 *     type: "key",
 *     version: 0, // change the version when you change your code
 *     adapter: new FileAdapter("/home/bot/data"),
 *   },
 * });
 * ```
 *
 * A list of known storage adapters can be found
 * [here](https://github.com/grammyjs/storages/tree/main/packages#grammy-storages).
 *
 * It is advisable to version your data when you persist it. Every time you
 * change your conversation function, you can increment the version. That way,
 * the conversations plugin can make sure to avoid any data corruption caused by
 * mismatches between state and implementation.
 *
 * Note that the plugin takes two different type parameters. The first type
 * parameter should corresopnd with the context type of the outside middleware
 * tree. The second type parameter should correspond with the custom context
 * type used inside all conversations. If you may want to use different context
 * types for different conversations, you can simply use `Context` here, and
 * adjust the type for each conversation individually.
 *
 * Be sure to read [the documentation about the conversations
 * plugin](https://grammy.dev/plugins/conversations) to learn more about how to
 * use it.
 *
 * @param options Optional options for the conversations plugin
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside conversations
 */
export function conversations<OC extends Context, C extends Context>(
    options: ConversationOptions<OC, C> = {},
): MiddlewareFn<ConversationFlavor<OC>> {
    const createStorage = uniformStorage(options.storage);
    return async (ctx, next) => {
        if (internalRecursionDetection in ctx) {
            throw new Error(
                "Cannot install the conversations plugin on context objects created by the conversations plugin!",
            );
        }
        if (internalState in ctx) {
            throw new Error("Cannot install conversations plugin twice!");
        }

        const storage = createStorage(ctx);
        let read = false;
        const state = await storage.read() ?? {};
        const empty = Object.keys(state).length === 0;
        function getData() {
            read = true;
            return state; // will be mutated by conversations
        }

        const index: ConversationIndex<OC, C> = new Map();
        async function enter(id: string, ...args: unknown[]) {
            const entry = index.get(id);
            if (entry === undefined) {
                const known = Array.from(index.keys())
                    .map((id) => `'${id}'`)
                    .join(", ");
                throw new Error(
                    `The conversation '${id}' has not been registered! Known conversations are: ${known}`,
                );
            }
            const { builder, plugins, maxMillisecondsToWait } = entry;
            await options.onEnter?.(id, ctx);
            const base: ContextBaseData = {
                update: ctx.update,
                api: ctx.api,
                me: ctx.me,
            };
            return await enterConversation(builder, base, {
                args,
                ctx,
                plugins,
                maxMillisecondsToWait,
            });
        }
        const exit = options.onExit !== undefined
            ? async (name: string) => {
                await options.onExit?.(name, ctx);
            }
            : undefined;
        function isParallel(name: string) {
            return index.get(name)?.parallel ?? true;
        }

        function canSave() {
            return !(internalCompletenessMarker in ctx);
        }

        const internal: InternalState<OC, C> = {
            getMutableData: getData,
            index,
            defaultPlugins: options.plugins ?? [],
            exitHandler: exit,
        };
        Object.defineProperty(ctx, internalState, { value: internal });
        ctx.conversation = controls(getData, isParallel, enter, exit, canSave);
        try {
            await next();
        } finally {
            Object.defineProperty(ctx, internalCompletenessMarker, {
                value: true,
            });
            if (read) {
                // In case of bad usage of async/await, it is possible that
                // `next` resolves while an enter call is still running. It then
                // may not have cleaned up its data, leaving behind empty arrays
                // on the state. Instead of delegating the cleanup
                // responsibility to enter calls which are unable to do this
                // reliably, we purge empty arrays ourselves before persisting
                // the state. That way, we don't store useless data even when
                // bot developers mess up.
                const keys = Object.keys(state);
                const len = keys.length;
                let del = 0;
                for (let i = 0; i < len; i++) {
                    const key = keys[i];
                    if (state[key].length === 0) {
                        delete state[key];
                        del++;
                    }
                }
                if (len !== del) { // len - del > 0
                    await storage.write(state);
                } else if (!empty) {
                    await storage.delete();
                }
            }
        }
    };
}

/**
 * State of a single conversation.
 *
 * Objects of this type are persisted when a conversation is interrupted and the
 * state of execution is stored in the database.
 */
export interface ConversationState {
    /** JSON string of the arguments supplied to a conversation */
    args?: string;
    /** The replay state containing the state of execution */
    replay: ReplayState;
    /** A list of pending interrupts that can be resolved */
    interrupts: number[];
}

/**
 * A result of running a conversation builder function.
 *
 * This is a union of four possible outcomes of the replay. The union members
 * are discriminated by their `status` property. The replay may have completed
 * normally, thrown an error, or consumed or skipped the update.
 */
export type ConversationResult =
    | ConversationComplete
    | ConversationError
    | ConversationHandled
    | ConversationSkipped;
/**
 * A conversation result indicating that the conversation has completed normally
 * by returning.
 */
export interface ConversationComplete {
    /** New status of the conversation, always `"complete"` */
    status: "complete";
    /** Whether the conversation demands downstream middleware to be called */
    next: boolean;
}
/**
 * A conversation result indicating that the conversation has completed by
 * throwing an error.
 */
export interface ConversationError {
    /** New status of the conversation, always `"error"` */
    status: "error";
    /** The thrown error object */
    error: unknown;
}
/**
 * A conversation result indicating that the conversation has handled the
 * update. This happens when the conversation builder function was
 * interrupted by calling `wait`.
 *
 * Contains the new replay state which can be used to resume the conversation
 * further. Also contains a list of pending interrupts which identify the
 * unresolved `wait` calls.
 */
export interface ConversationHandled {
    /** New status of the conversation, always `"handled"` */
    status: "handled";
    /** The new replay state after handling the update */
    replay: ReplayState;
    /** A list of pending interrupts to resume the conversation */
    interrupts: number[];
}
/**
 * A conversation result indicating that the conversation has decided to skip
 * handling this update. This happens when the conversation builder function
 * cancels the execution using `skip`.
 */
export interface ConversationSkipped {
    /** New status of the conversation, always `"skipped"` */
    status: "skipped";
    /** Whether the conversation demands downstream middleware to be called */
    next: boolean;
}

/**
 * A conversation builder function.
 *
 * This is the type of function that defines a conversation. Conversation buider
 * functions receive as their first argument an instance of
 * {@link Conversation}. This allows them to wait for updates and control the
 * conversation in various other ways.
 *
 * As a second argument, the first context object is received. This context
 * object contains the update that was used to enter the conversation.
 *
 * Any additional arguments are the values provided to the enter call. Note that
 * there is no type safety for these parameters.
 *
 * @param conversation A conversation handle
 * @param ctx The initial context object
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside conversations
 */
export type ConversationBuilder<OC extends Context, C extends Context> = (
    conversation: Conversation<OC, C>,
    ctx: C,
    // deno-lint-ignore no-explicit-any
    ...args: any[]
) => Promise<unknown> | unknown;
/**
 * Configuration options for a conversation. These options can be passed to
 * {@link createConversation} when installing the conversation.
 *
 * @typeParam C The type of context object used inside this conversation
 */
export interface ConversationConfig<C extends Context> {
    /**
     * Identifier of the conversation. The identifier can be used to enter or
     * exit conversations from middleware.
     *
     * Defaults to [the JavaScript function
     * name](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/name).
     */
    id?: string;
    /**
     * An array of plugins to be installed on every context object created by
     * the conversation.
     *
     * Remember that when a conversation is executed, it creates a number of
     * context objects from scratch during each replay. If this is not obvious
     * to you, it means that you probably should read [the documentation of this
     * plugin](https://grammy.dev/plugins/conversations) in order to avoid
     * common pitfalls.
     *
     * The created context objects did not pass through the middleware tree, so
     * they will not have any properties installed on them. You can use this
     * configuration option to specify a number of grammY plugins that should
     * receive each context object created by the conversation.
     *
     * This lets you use many plugins inside the conversation. However, there
     * are still a few things to be aware of. In a typical middleware pass,
     * every plugin can process a context object, then call `next` to wait for
     * downstream middleware to finish, and then get the opportunity to perform
     * cleanup tasks or execute other code after the update was processed
     * downstream.
     *
     * Passing middleware to the `plugins` array will behave differently in the
     * sense that a call to `next` will resolve immediately. The context object
     * is given to the conversation only after all plugins have processed it.
     * Plugins that depend on executing tasks after calling `next` therefore
     * will not work correctly.
     *
     * If a plugin decides to fully handle an update by not calling `next`, then
     * this will consume the update. Any pending `wait` calls inside the
     * conversation will only receive the next incoming update.
     *
     * Note that you can install Bot API transformers from inside middleware,
     * too. This lets you modify the instances of `Api` created by the
     * conversations plugin.
     *
     * ```ts
     * plugins: [async (ctx, next) => {
     *   ctx.api.config.use(transformer)
     *   await next()
     * }]
     * ```
     *
     * In some cases, TypeScript is known not to be able to infer the correct
     * context type for plugins passed to this configuration option. The types
     * are still checked, though, which leads to compilation errors. They can be
     * fixed by passing the custom context type to the plugins explicitly. Note
     * that you need to use the custom context type used inside the
     * conversation, not the custom context type used in the outside middleware.
     */
    plugins?: Middleware<C>[];
    /**
     * Specifies a default timeout for all wait calls inside the conversation.
     *
     * This value can be overridden for each wait call by passing a different
     * timeout value.
     */
    maxMillisecondsToWait?: number;
    /**
     * Marks the conversation as parallel.
     *
     * By default, only a single conversation can ben active per chat. When this
     * option is set to `true`, this conversation can be entered when a
     * different conversation with the same or a different identifier is already
     * active. For example, in a single group chat, you can have 10 different
     * active conversations with 10 different users all at the same time.
     *
     * Conversations from different chats are always parallel.
     *
     * Only a single conversation can handle an update. When multiple
     * conversations are active at the same time in a chat, only the first
     * conversation will receive the update. If it decides to skip the update,
     * the second conversation will receive the update. This order is determined
     * by the order in which the different conversations are installed in the
     * middleware tree. If multiple conversations with the same identifer are
     * active, they will recieve the update in chronological order of the time
     * that the conversations were entered.
     *
     * By default, when a conversation decides to skip an update, the update
     * will be dropped. When a conversation is marked as parallel, it will
     * default to returning the update to the middleware system so that other
     * active conversations can pick up the update and handle it. This also
     * means that if you mark a conversation as parallel, unrelated downstream
     * middleware might process the update.
     *
     * When an update is skipped, an option `next` can be passed to override the
     * above behavior. This lets you decide for every call to `skip` whether
     * parallel conversations as well as other middleware shall receive an
     * update, or whether the update should be dropped. The same option exists
     * for filtered wait calls, chained wait calls, and conversational forms.
     *
     * Defaults to `false`.
     */
    parallel?: boolean;
}

/**
 * Takes a {@link ConversationBuilder | conversation builder function}, and
 * turns it into middleware that can be installed on your bot. This middleware
 * registers the conversation on the context object. Downstream handlers can
 * then enter the conversation using `ctx.conversation.enter`.
 *
 * When an update reaches this middleware and the given conversation is
 * currently active, then it will receive the update and process it. This
 * advances the conversation.
 *
 * If the conversation is marked as parallel, downstream middleware will be
 * called if this conversation decides to skip the update.
 *
 * You can pass a second parameter of type string to this function in order to
 * give a different identifier to the conversation. By default, [the name of the
 * function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/name)
 * is used.
 *
 * ```ts
 * bot.use(createConversation(example, "new-name"))
 * ```
 *
 * Optionally, instead of passing an identifier string as a second argument, you
 * can pass an options object. It lets you configure the conversation. For example, this is how you can mark a conversation as parallel.
 *
 * ```ts
 * bot.use(createConversation(example, {
 *   id: "new-name",
 *   parallel: true,
 * }))
 * ```
 *
 * Note that this function takes two different type parameters. The first type
 * parameter should corresopnd with the context type of the outside middleware
 * tree. The second type parameter should correspond with the custom context
 * type used inside the given conversation. These two custom context types can
 * never be identical because the outside middleware must have
 * {@link ConversationFlavor} installed, but the custom context type used in the
 * conversation must never have this type installed.
 *
 * @param builder A conversation builder function
 * @param options A different name for the conversation, or an options object
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside this conversation
 */
export function createConversation<OC extends Context, C extends Context>(
    builder: ConversationBuilder<OC, C>,
    options?: string | ConversationConfig<C>,
): MiddlewareFn<ConversationFlavor<OC>> {
    const {
        id = builder.name,
        plugins = [],
        maxMillisecondsToWait = undefined,
        parallel = false,
    } = typeof options === "string" ? { id: options } : options ?? {};
    if (!id) {
        throw new Error("Cannot register a conversation without a name!");
    }
    return async (ctx, next) => {
        if (!(internalState in ctx)) {
            throw new Error(
                "Cannot register a conversation without installing the conversations plugin first!",
            );
        }

        const { index, defaultPlugins, getMutableData, exitHandler } =
            ctx[internalState] as InternalState<OC, C>;
        if (index.has(id)) {
            throw new Error(`Duplicate conversation identifier '${id}'!`);
        }
        const combinedPlugins = [...defaultPlugins, ...plugins];
        index.set(id, {
            builder,
            plugins: combinedPlugins,
            maxMillisecondsToWait,
            parallel,
        });
        const onHalt = async () => {
            await exitHandler?.(id);
        };

        const mutableData = getMutableData();
        const base: ContextBaseData = {
            update: ctx.update,
            api: ctx.api,
            me: ctx.me,
        };
        const options: ResumeOptions<OC, C> = {
            ctx,
            plugins: combinedPlugins,
            onHalt,
            maxMillisecondsToWait,
            parallel,
        };
        const result = await runParallelConversations(
            builder,
            base,
            id,
            mutableData, // will be mutated on ctx
            options,
        );
        switch (result.status) {
            case "complete":
            case "skipped":
                if (result.next) await next();
                return;
            case "error":
                throw result.error;
            case "handled":
                return;
        }
    };
}

/**
 * Takes a conversation builder function and some state and runs all parallel
 * instances of it until a conversation result was produced.
 *
 * This is used internally to run a conversation, but bots typically don't have
 * to call this method.
 *
 * @param builder A conversation builder function
 * @param base Context base data containing the incoming update
 * @param id The identifier of the conversation
 * @param data The state of execution of all parallel conversations
 * @param options Additional configuration options
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside this conversation
 */
export async function runParallelConversations<
    OC extends Context,
    C extends Context,
>(
    builder: ConversationBuilder<OC, C>,
    base: ContextBaseData,
    id: string,
    data: ConversationData,
    options?: ResumeOptions<OC, C>,
): Promise<ConversationResult> {
    if (!(id in data)) return { status: "skipped", next: true };
    const states = data[id];
    const len = states.length;
    for (let i = 0; i < len; i++) {
        const state = states[i];
        const result = await resumeConversation(builder, base, state, options);
        switch (result.status) {
            case "skipped":
                if (result.next) continue;
                else return { status: "skipped", next: false };
            case "handled":
                states[i].replay = result.replay;
                states[i].interrupts = result.interrupts;
                return result;
            case "complete":
                states.splice(i, 1);
                if (states.length === 0) delete data[id];
                if (result.next) continue;
                else return result;
            case "error":
                states.splice(i, 1);
                if (states.length === 0) delete data[id];
                return result;
        }
    }
    return { status: "skipped", next: true };
}

/**
 * A result of entering a conversation builder function.
 *
 * This is a union of four possible outcomes of the initial execution. The union
 * members are discriminated by their `status` property. The execution may have
 * completed normally, thrown an error, or consumed or skipped the update.
 */
export type EnterResult =
    | EnterComplete
    | EnterError
    | EnterHandled
    | EnterSkipped;
/**
 * An enter result indicating that the conversation has immediately completed
 * normally by returning.
 */
export type EnterComplete = ConversationComplete;
/**
 * An enter result indicating that the conversation has completed by throwing an
 * error.
 */
export type EnterError = ConversationError;
/**
 * An enter result indicating that the conversation has handled the update. This
 * happens when the conversation builder function was interrupted by calling
 * `wait`.
 *
 * Contains the created replay state which can be used to resume the
 * conversation further. Also contains a list of pending interrupts which
 * identify the unresolved `wait` calls.
 */
export interface EnterHandled extends ConversationHandled {
    /**
     * A JSON string containing the arguments of the enter call. May be absent
     * if no arguments were provided.
     */
    args?: string;
}
/**
 * An enter result indicating that the conversation has decided to skip handling
 * this update. This happens when the conversation builder function cancels the
 * execution using `skip` immediately after being entered. The conversation will
 * remain active and can handle the next update.
 */
export interface EnterSkipped extends ConversationSkipped {
    /**
     * A JSON string containing the arguments of the enter call. May be absent
     * if no arguments were provided.
     */
    args?: string;
    /** The created replay state after handling the update */
    replay: ReplayState;
    /** A list of pending interrupts to resume the conversation */
    interrupts: number[];
}

/** Options to pass when manually running a conversation from scratch */
export interface EnterOptions<OC extends Context, C extends Context>
    extends ResumeOptions<OC, C> {
    /** A list of arguments to pass to the conversation */
    args?: unknown[];
}
/**
 * Begins a new execution of a conversation builder function from scratch until
 * a result was produced.
 *
 * This is used internally to enter a conversation, but bots typically don't have
 * to call this method.
 *
 * @param conversation A conversation builder function
 * @param base Context base data containing the incoming update
 * @param options Additional configuration options
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside this conversation
 */
export async function enterConversation<OC extends Context, C extends Context>(
    conversation: ConversationBuilder<OC, C>,
    base: ContextBaseData,
    options?: EnterOptions<OC, C>,
): Promise<EnterResult> {
    const { args = [], ...opts } = options ?? {};
    const [initialState, int] = ReplayEngine.open("wait");
    const packedArgs = args.length === 0 ? {} : { args: JSON.stringify(args) };
    const state: ConversationState = {
        ...packedArgs,
        replay: initialState,
        interrupts: [int],
    };
    const result = await resumeConversation(conversation, base, state, opts);
    switch (result.status) {
        case "complete":
        case "error":
            return result;
        case "handled":
            return { ...packedArgs, ...result };
        case "skipped":
            return {
                ...packedArgs,
                replay: initialState,
                interrupts: state.interrupts,
                ...result,
            };
    }
}

/** Options to pass when manually resuming a conversation */
export interface ResumeOptions<OC extends Context, C extends Context> {
    /** A context object from the outside middleware to use in `external` */
    ctx?: OC;
    /** An array of plugins to run for newly created context objects */
    plugins?: Middleware<C>[];
    /** A callback function to run if `conversation.halt` is called */
    onHalt?(): void | Promise<void>;
    /** A default wait timeout */
    maxMillisecondsToWait?: number;
    /** Whether this conversation is parallel */
    parallel?: boolean;
}

/**
 * Resumes an execution of a conversation builder function until a result was
 * produced.
 *
 * This is used internally to resume a conversation, but bots typically don't
 * have to call this method.
 *
 * @param conversation A conversation builder function
 * @param base Context base data containing the incoming update
 * @param state Previous state of the conversation
 * @param options Additional configuration options
 * @typeParam OC Custom context type of the outside middleware
 * @typeParam C Custom context type used inside this conversation
 */
export async function resumeConversation<OC extends Context, C extends Context>(
    conversation: ConversationBuilder<OC, C>,
    base: ContextBaseData,
    state: ConversationState,
    options?: ResumeOptions<OC, C>,
): Promise<ConversationResult> {
    const { update, api, me } = base;
    const args = state.args === undefined ? [] : JSON.parse(state.args);
    const {
        ctx = youTouchYouDie<OC>(
            "The conversation was advanced from an event so there is no access to an outside context object",
        ),
        plugins = [],
        onHalt,
        maxMillisecondsToWait,
        parallel,
    } = options ?? {};
    const middleware = new Composer(...plugins).middleware();
    // deno-lint-ignore no-explicit-any
    const escape = (fn: (ctx: OC) => any) => fn(ctx);
    const engine = new ReplayEngine(async (controls) => {
        const hydrate = hydrateContext<C>(controls, api, me);
        const convo = new Conversation(controls, hydrate, escape, middleware, {
            onHalt,
            maxMillisecondsToWait,
            parallel,
        });
        const ctx = await convo.wait({ maxMilliseconds: undefined });
        await conversation(convo, ctx, ...args);
    });
    const replayState = state.replay;
    // The last execution may have completed with a number of interrupts
    // (parallel wait calls, floating promises basically). We replay the
    // conversation once for each of these interrupts until one of them does not
    // skip the update (actually handles it in a meaningful way).
    const ints = state.interrupts;
    const len = ints.length;
    let next = true;
    INTERRUPTS: for (let i = 0; i < len; i++) {
        const int = ints[i];
        const checkpoint = ReplayEngine.supply(replayState, int, update);
        let rewind: boolean;
        do {
            rewind = false;
            const result = await engine.replay(replayState);
            switch (result.type) {
                case "returned":
                    // tell caller that we are done, all good
                    return { status: "complete", next: false };
                case "thrown":
                    // tell caller that an error was thrown, it should leave the
                    // conversation and rethrow the error
                    return { status: "error", error: result.error };
                case "interrupted":
                    // tell caller that we handled the update and updated the
                    // state accordingly
                    return {
                        status: "handled",
                        replay: result.state,
                        interrupts: result.interrupts,
                    };
                // TODO: disable lint until the following issue is fixed:
                // https://github.com/denoland/deno_lint/issues/1331
                // deno-lint-ignore no-fallthrough
                case "canceled":
                    // check the type of interrupt by inspecting its message
                    if (Array.isArray(result.message)) {
                        const c = result.message as Checkpoint;
                        ReplayEngine.reset(replayState, c);
                        rewind = true;
                        break;
                    }
                    switch (result.message) {
                        case "skip":
                            // current interrupt was skipped, replay again with
                            // the next interrupt from the list
                            ReplayEngine.reset(replayState, checkpoint);
                            next = true;
                            continue INTERRUPTS;
                        case "drop":
                            // current interrupt was skipped, replay again with
                            // the next and if this was the last iteration of
                            // the loop, then tell the caller that downstream
                            // middleware must be called
                            ReplayEngine.reset(replayState, checkpoint);
                            next = false;
                            continue INTERRUPTS;
                        case "halt":
                            // tell caller that we are done, all good
                            return { status: "complete", next: false };
                        case "kill":
                            // tell the called that we are done and that
                            // downstream middleware must be called
                            return { status: "complete", next: true };
                        default:
                            throw new Error("invalid cancel message received"); // cannot happen
                    }
                default:
                    // cannot happen
                    throw new Error(
                        "engine returned invalid replay result type",
                    );
            }
        } while (rewind);
    }
    // tell caller that we want to skip the update and did not modify the state
    return { status: "skipped", next };
}

function hydrateContext<C extends Context>(
    controls: ReplayControls,
    protoApi: ApiBaseData,
    me: UserFromGetMe,
) {
    return (update: Update) => {
        const api = new Api(protoApi.token, protoApi.options);
        api.config.use(async (prev, method, payload, signal) => {
            // Prepare values before storing them
            async function action() {
                try {
                    const res = await prev(method, payload, signal);
                    return { ok: true, res } as const; // directly return successful responses
                } catch (e) {
                    if (e instanceof HttpError) { // dismantle HttpError instances
                        return {
                            ok: false,
                            err: {
                                message: e.message,
                                error: JSON.stringify(e.error),
                            },
                        } as const;
                    } else {
                        throw new Error(
                            `Unknown error thrown in conversation while calling '${method}'`,
                            // @ts-ignore not available on old Node versions
                            { cause: e },
                        );
                    }
                }
            }
            const ret = await controls.action(action, method);
            // Recover values after loading them
            if (ret.ok) {
                return ret.res;
            } else {
                throw new HttpError(
                    "Error inside conversation: " + ret.err.message,
                    new Error(JSON.parse(ret.err.error)),
                );
            }
        });
        const ctx = new Context(update, api, me) as C;
        Object.defineProperty(ctx, internalRecursionDetection, { value: true });
        return ctx;
    };
}
