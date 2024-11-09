import {
    type CallbackQueryContext,
    type CommandContext,
    Context,
    type Filter,
    type FilterQuery,
    type GameQueryContext,
    type HearsContext,
    type MiddlewareFn,
    type ReactionContext,
    type ReactionType,
    type ReactionTypeEmoji,
    type Update,
    type User,
} from "./deps.deno.ts";
import { type Checkpoint, type ReplayControls } from "./engine.ts";
import { ConversationForm } from "./form.ts";
import { type ConversationMenuOptions, ConversationMenuPool } from "./menu.ts";

type MaybeArray<T> = T | T[];
/** Alias for `string` but with auto-complete for common commands */
export type StringWithCommandSuggestions =
    | (string & Record<never, never>)
    | "start"
    | "help"
    | "settings"
    | "privacy"
    | "developer_info";

/**
 * Specifies an external operation and how to serialize and deserialize its
 * return and error values.
 *
 * @typeParam OC Type of the outside context object
 * @typeParam R Type of the return value
 * @typeParam I Type of the intermediate (serialized) representation
 */
// deno-lint-ignore no-explicit-any
export interface ExternalOp<OC extends Context, R, I = any> {
    /**
     * The external operation to perform.
     *
     * Receives the current context object from the surrounding middleware. This
     * gives the task access to sessions (if used) and other values that are not
     * present inside the conversation.
     *
     * > Note that the type of the context object is only inferred to be
     * > `Context`. If you use a custom context type, you have to annotate the
     * > parameter correctly. This will perform an unsafe type cast internally.
     *
     * @param ctx The outside context object of the surrounding middleware
     */
    task(ctx: OC): R | Promise<R>;
    /**
     * Converts a value returned from the task to an object that can safely be
     * passed to `JSON.stringify`.
     *
     * @param value A value to serialize
     */
    beforeStore?(value: R): I | Promise<I>;
    /**
     * Restores the original value from the intermediate representation that
     * `beforeStore` generated.
     *
     * @param value The value obtained from `JSON.parse`
     */
    afterLoad?(value: I): R | Promise<R>;
    /**
     * Converts an error thrown by the task to an object that can safely be
     * passed to `JSON.stringify`.
     *
     * @param value A thrown error
     */
    beforeStoreError?(value: unknown): unknown | Promise<unknown>;
    /**
     * Restores the original error from the intermediate representation that
     * `beforeStoreError` generated.
     *
     * @param value The value obtained from `JSON.parse`
     */
    afterLoadError?(value: unknown): unknown | Promise<unknown>;
}
/** A function that applies a context object to a callback */
type ApplyContext<OC extends Context> = <F extends (ctx: OC) => unknown>(
    fn: F,
) => Promise<ReturnType<F>>;

/** Options for creating a conversation handle */
export interface ConversationHandleOptions {
    /** Callback for when the conversation is halted */
    onHalt?(): void | Promise<void>;
    /** Default wait timeout */
    maxMillisecondsToWait?: number;
    /**
     * `true` if this conversation can be entered while this or another
     * conversation is already active, and `false` otherwise. Defaults to
     * `false`.
     */
    parallel?: boolean;
}

/**
 * Options for a call to `conversation.wait()`.
 */
export interface WaitOptions {
    /**
     * Specifies a timeout for the wait call.
     *
     * When the wait call is reached, `Date.now()` is called. When the wait call
     * resolves, `Date.now()` is called again, and the two values are compared.
     * If the wait call resolved more than the specified number of milliseconds
     * after it was reached initially, then the conversation will be halted, any
     * exit handlers will be called, and the surrounding middleware will resume
     * normally so that subsequent handlers can run.
     *
     * To the outside middleware system, this will look like the conversation
     * was never active.
     */
    maxMilliseconds?: number;
    /**
     * Collation key for the wait call, safety measure to protect against data
     * corruption. This is used extensively by the plugin internally, but it is
     * rarely useful to changes this behavior.
     */
    collationKey?: string;
}
/**
 * Options for a call to `conversation.skip()`.
 */
export interface SkipOptions {
    /**
     * Determines whether [the outside middleware
     * system](https://grammy.dev/guide/middleware) should resume after the
     * update is skipped.
     *
     * Pass `{ next: true }` to make sure that subsequent handlers will run.
     * This effectively causes `next` to be called by the plugin.
     *
     * Defaults to `false` unless the conversation is marked as parallel, in
     * which case this option defaults to `true`.
     */
    next?: boolean;
}
/**
 * Options to pass to a chained `wait` call.
 */
export interface AndOtherwiseOptions<C extends Context> extends SkipOptions {
    /**
     * Callback that will be invoked when the validation fails for a context
     * object.
     *
     * @param ctx The context object that failed validation
     */
    otherwise?(ctx: C): unknown | Promise<unknown>;
}

/**
 * Options for a filtered wait call. A filtered wait call is a wait call that
 * have extra valiation attached, such as `waitFor`, `waitUntil`, etc.
 */
export interface OtherwiseOptions<C extends Context>
    extends WaitOptions, AndOtherwiseOptions<C> {}

/**
 * Options for a call to `conversation.halt()`.
 */
export interface HaltOptions {
    /**
     * Determines whether [the outside middleware
     * system](https://grammy.dev/guide/middleware) should resume after the
     * conversation is halted.
     *
     * Pass `{ next: true }` to make sure that subsequent handlers will run.
     * This effectively causes `next` to be called by the plugin.
     *
     * Defaults to `false`.
     */
    next?: boolean;
}

/**
 * A conversation handle lets you control the conversation, such as waiting for
 * updates, skipping them, halting the conversation, and much more. It is the
 * first parameter in each conversation builder function and provides the core
 * features of this plugin.
 *
 * ```ts
 * async function exmaple(conversation, ctx) {
 *   //                   ^ this is an instance of this class
 *
 *   // This is how you can wait for updates:
 *   ctx = await conversation.wait()
 * }
 * ```
 *
 * Be sure to consult this plugin's documentation:
 * https://grammy.dev/plugins/conversations
 */
export class Conversation<OC extends Context, C extends Context> {
    /** `true` if `external` is currently running, `false` otherwise */
    private insideExternal = false;

    private menuPool = new ConversationMenuPool<C>();

    private combineAnd = makeAndCombiner(this);

    /**
     * Constructs a new conversation handle.
     *
     * This is called internally in order to construct the first argument for a
     * conversation builder function. You typically don't need to construct this
     * class yourself.
     *
     * @param controls Controls for the underlying replay engine
     * @param hydrate Context construction callback
     * @param escape Callback to support outside context objects in `external`
     * @param plugins Middleware to hydrate context objects
     * @param options Additional configuration options
     */
    constructor(
        private controls: ReplayControls,
        private hydrate: (update: Update) => C,
        private escape: ApplyContext<OC>,
        private plugins: MiddlewareFn<C>,
        private options: ConversationHandleOptions,
    ) {}
    /**
     * Waits for a new update and returns the corresponding context object as
     * soon as it arrives.
     *
     * Note that wait calls terminate the conversation function, save the state
     * of execution, and only resolve when the conversation is replayed. If this
     * is not obvious to you, it means that you probably should read [the
     * documentation of this plugin](https://grammy.dev/plugins/conversations)
     * in order to avoid common pitfalls.
     *
     * You can pass a timeout in the optional options object. This lets you
     * terminate the conversation automatically if the update arrives too late.
     *
     * @param options Optional options for wait timeouts etc
     */
    wait(options: WaitOptions = {}): AndPromise<C> {
        if (this.insideExternal) {
            throw new Error(
                "Cannot wait for updates from inside `external`, or concurrently to it! \
First return your data from `external` and then resume update handling using `wait` calls.",
            );
        }
        const makeWait = async () => {
            // obtain update
            const limit = "maxMilliseconds" in options
                ? options.maxMilliseconds
                : this.options.maxMillisecondsToWait;
            const key = options.collationKey ?? "wait";
            const before = limit !== undefined && await this.now();
            const update = await this.controls.interrupt(key) as Update;
            if (before !== false) {
                const after = await this.now();
                if (after - before >= limit) {
                    await this.halt({ next: true });
                }
            }

            // convert to context object
            const ctx = this.hydrate(update);
            // prepare context for menus
            const { handleClicks } = this.menuPool.install(ctx);

            // run plugins
            let pluginsCalledNext = false;
            await this.plugins(ctx, () => {
                pluginsCalledNext = true;
                return Promise.resolve();
            });
            // If a plugin decided to handle the update (did not call `next`),
            // then we recurse and simply wait for another update.
            if (!pluginsCalledNext) return await this.wait(options);

            // run menus
            const { next: menuCalledNext } = await handleClicks();
            // If a menu decided to handle the update (did not call `next`),
            // then we recurse and simply wait for another update.
            if (!menuCalledNext) return await this.wait(options);

            return ctx;
        };
        return this.combineAnd(makeWait());
    }
    /**
     * Performs a filtered wait call that is defined by a given predicate. In
     * other words, this method waits for an update, and calls `skip` if the
     * received context object does not pass validation performed by the given
     * predicate function.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitUntil(ctx => ctx.msg?.text?.endsWith("grammY"), {
     *   otherwise: ctx => ctx.reply("Send a message that ends with grammY!")
     * })
     * ```
     *
     * If you pass a type predicate, the type of the resulting context object
     * will be narrowed down.
     *
     * ```ts
     * const ctx = await conversation.waitUntil(Context.has.filterQuery(":text"))
     * const text = ctx.msg.text;
     * ```
     *
     * You can combine calls to `waitUntil` with other filtered wait calls by
     * chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitUntil(ctx => ctx.msg?.text?.endsWith("grammY"))
     *   .andFor("::hashtag")
     * ```
     *
     * @param predicate A predicate function to validate context objects
     * @param opts Optional options object
     */
    waitUntil<D extends C>(
        predicate: (ctx: C) => ctx is D,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<D>;
    waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<C>;
    waitUntil(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts: OtherwiseOptions<C> = {},
    ): AndPromise<C> {
        const makeWait = async () => {
            const { otherwise, next, ...waitOptions } = opts;
            const ctx = await this.wait({
                collationKey: "until",
                ...waitOptions,
            });
            if (!await predicate(ctx)) {
                await otherwise?.(ctx);
                await this.skip({ next });
            }
            return ctx;
        };
        return this.combineAnd(makeWait());
    }
    /**
     * Performs a filtered wait call that is defined by a given negated
     * predicate. In other words, this method waits for an update, and calls
     * `skip` if the received context object passed validation performed by the
     * given predicate function. That is the exact same thigs as calling
     * {@link Conversation.waitUntil} but with the predicate function being
     * negated.
     *
     * If a context object is discarded (the predicate function returns `true`
     * for it), you can perform any action by specifying `otherwise` in the
     * options.
     *
     * ```ts
     * const ctx = await conversation.waitUnless(ctx => ctx.msg?.text?.endsWith("grammY"), {
     *   otherwise: ctx => ctx.reply("Send a message that does not end with grammY!")
     * })
     * ```
     *
     * You can combine calls to `waitUnless` with other filtered wait calls by
     * chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitUnless(ctx => ctx.msg?.text?.endsWith("grammY"))
     *   .andFor("::hashtag")
     * ```
     *
     * @param predicate A predicate function to discard context objects
     * @param opts Optional options object
     */
    waitUnless(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<C> {
        return this.combineAnd(
            this.waitUntil(async (ctx) => !await predicate(ctx), {
                collationKey: "unless",
                ...opts,
            }),
        );
    }
    /**
     * Performs a filtered wait call that is defined by a filter query. In other
     * words, this method waits for an update, and calls `skip` if the received
     * context object does not match the filter query. This uses the same logic
     * as `bot.on`.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitFor(":text", {
     *   otherwise: ctx => ctx.reply("Please send a text message!")
     * })
     * // Type inference works:
     * const text = ctx.msg.text;
     * ```
     *
     * You can combine calls to `waitFor` with other filtered wait calls by
     * chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitFor(":text").andFor("::hashtag")
     * ```
     *
     * @param query A filter query to match
     * @param opts Optional options object
     */
    waitFor<Q extends FilterQuery>(
        query: Q | Q[],
        opts?: OtherwiseOptions<C>,
    ): AndPromise<Filter<C, Q>> {
        return this.combineAnd(
            this.waitUntil(Context.has.filterQuery(query), {
                collationKey: Array.isArray(query) ? query.join(",") : query,
                ...opts,
            }),
        );
    }
    /**
     * Performs a filtered wait call that is defined by a hears filter. In other
     * words, this method waits for an update, and calls `skip` if the received
     * context object does not contain text that matches the given text or
     * regular expression. This uses the same logic as `bot.hears`.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitForHears(["yes", "no"], {
     *   otherwise: ctx => ctx.reply("Please send yes or no!")
     * })
     * // Type inference works:
     * const answer = ctx.match
     * ```
     *
     * You can combine calls to `waitForHears` with other filtered wait calls by
     * chaining them. For instance, this can be used to only receive text from
     * text messages—not including channel posts or media captions.
     *
     * ```ts
     * const ctx = await conversation.waitForHears(["yes", "no"])
     *   .andFor("message:text")
     * const text = ctx.message.text
     * ```
     *
     * @param trigger The text to look for
     * @param opts Optional options object
     */
    waitForHears(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<HearsContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.text(trigger), {
            collationKey: "hears",
            ...opts,
        }));
    }
    /**
     * Performs a filtered wait call that is defined by a command filter. In
     * other words, this method waits for an update, and calls `skip` if the
     * received context object does not contain the expected command. This uses
     * the same logic as `bot.command`.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitForCommand("start", {
     *   otherwise: ctx => ctx.reply("Please send /start!")
     * })
     * // Type inference works for deep links:
     * const args = ctx.match
     * ```
     *
     * You can combine calls to `waitForCommand` with other filtered wait calls
     * by chaining them. For instance, this can be used to only receive commands
     * from text messages—not including channel posts.
     *
     * ```ts
     * const ctx = await conversation.waitForCommand("start")
     *   .andFor("message")
     * ```
     *
     * @param command The command to look for
     * @param opts Optional options object
     */
    waitForCommand(
        command: MaybeArray<StringWithCommandSuggestions>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<CommandContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.command(command), {
            collationKey: "command",
            ...opts,
        }));
    }
    /**
     * Performs a filtered wait call that is defined by a reaction filter. In
     * other words, this method waits for an update, and calls `skip` if the
     * received context object does not contain the expected reaction update.
     * This uses the same logic as `bot.reaction`.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitForReaction('👍', {
     *   otherwise: ctx => ctx.reply("Please upvote a message!")
     * })
     * // Type inference works:
     * const args = ctx.messageReaction
     * ```
     *
     * You can combine calls to `waitForReaction` with other filtered wait calls
     * by chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitForReaction('👍')
     *   .andFrom(ADMIN_USER_ID)
     * ```
     *
     * @param reaction The reaction to look for
     * @param opts Optional options object
     */
    waitForReaction(
        reaction: MaybeArray<ReactionTypeEmoji["emoji"] | ReactionType>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<ReactionContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.reaction(reaction), {
            collationKey: "reaction",
            ...opts,
        }));
    }
    /**
     * Performs a filtered wait call that is defined by a callback query filter.
     * In other words, this method waits for an update, and calls `skip` if the
     * received context object does not contain the expected callback query
     * update. This uses the same logic as `bot.callbackQuery`.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitForCallbackQuery(/button-\d+/, {
     *   otherwise: ctx => ctx.reply("Please click a button!")
     * })
     * // Type inference works:
     * const data = ctx.callbackQuery.data
     * ```
     *
     * You can combine calls to `waitForCallbackQuery` with other filtered wait
     * calls by chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitForCallbackQuery('data')
     *   .andFrom(ADMIN_USER_ID)
     * ```
     *
     * @param trigger The string to look for in the payload
     * @param opts Optional options object
     */
    waitForCallbackQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<CallbackQueryContext<C>> {
        return this.combineAnd(
            this.waitUntil(Context.has.callbackQuery(trigger), {
                collationKey: "callback",
                ...opts,
            }),
        );
    }
    /**
     * Performs a filtered wait call that is defined by a game query filter. In
     * other words, this method waits for an update, and calls `skip` if the
     * received context object does not contain the expected game query update.
     * This uses the same logic as `bot.gameQuery`.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitForGameQuery(/game-\d+/, {
     *   otherwise: ctx => ctx.reply("Please play a game!")
     * })
     * // Type inference works:
     * const data = ctx.callbackQuery.game_short_name
     * ```
     *
     * You can combine calls to `waitForGameQuery` with other filtered wait
     * calls by chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitForGameQuery('data')
     *   .andFrom(ADMIN_USER_ID)
     * ```
     *
     * @param trigger The string to look for in the payload
     * @param opts Optional options object
     */
    waitForGameQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<GameQueryContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.gameQuery(trigger), {
            collationKey: "game",
            ...opts,
        }));
    }
    /**
     * Performs a filtered wait call that is defined by a user-specific filter.
     * In other words, this method waits for an update, and calls `skip` if the
     * received context object was not triggered by the given user.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitFrom(targetUser, {
     *   otherwise: ctx => ctx.reply("I did not mean you!")
     * })
     * // Type inference works:
     * const user = ctx.from.first_name
     * ```
     *
     * You can combine calls to `waitFrom` with other filtered wait calls by
     * chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitFrom(targetUser).andFor(":text")
     * ```
     *
     * @param user The user or user identifer to look for
     * @param opts Optional options object
     */
    waitFrom(
        user: number | User,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<C & { from: User }> {
        const id = typeof user === "number" ? user : user.id;
        return this.combineAnd(this.waitUntil(
            (ctx: C): ctx is C & { from: User } => ctx.from?.id === id,
            { collationKey: `from-${id}`, ...opts },
        ));
    }
    /**
     * Performs a filtered wait call that is defined by a message reply. In
     * other words, this method waits for an update, and calls `skip` if the
     * received context object does not contain a reply to a given message.
     *
     * If a context object is discarded, you can perform any action by
     * specifying `otherwise` in the options.
     *
     * ```ts
     * const ctx = await conversation.waitForReplyTo(message, {
     *   otherwise: ctx => ctx.reply("Please reply to this message!", {
     *     reply_parameters: { message_id: message.message_id }
     *   })
     * })
     * // Type inference works:
     * const id = ctx.msg.message_id
     * ```
     *
     * You can combine calls to `waitForReplyTo` with other filtered wait calls
     * by chaining them.
     *
     * ```ts
     * const ctx = await conversation.waitForReplyTo(message).andFor(":text")
     * ```
     *
     * @param message_id The message identifer or object to look for in a reply
     * @param opts Optional options object
     */
    waitForReplyTo(
        message_id: number | { message_id: number },
        opts?: OtherwiseOptions<C>,
    ): AndPromise<Filter<C, "message" | "channel_post">> {
        const id = typeof message_id === "number"
            ? message_id
            : message_id.message_id;
        return this.combineAnd(this.waitUntil(
            (ctx): ctx is Filter<C, "message" | "channel_post"> =>
                ctx.message?.reply_to_message?.message_id === id ||
                ctx.channelPost?.reply_to_message?.message_id === id,
            { collationKey: `reply-${id}`, ...opts },
        ));
    }

    /**
     * Skips the current update. The current update is the update that was
     * received in the last wait call.
     *
     * In a sense, this will undo receiving an update. The replay logs will be
     * reset so it will look like the conversation had never received the update
     * in the first place. Note, however, that any API calls performs between
     * wait and skip are not going to be reversed. In particular, messages will
     * not be unsent.
     *
     * By default, skipping an update drops it. This means that no other
     * handlers (including downstream middleware) will run. However, if this
     * conversation is marked as parallel, skip will behave differently and
     * resume middleware execution by default. This is needed for other parallel
     * conversations with the same or a different identifier to receive the
     * update.
     *
     * This behavior can be overridden by passing `{ next: true }` or `{ next:
     * false }` to skip.
     *
     * If several wait calls are used concurrently inside the same conversation,
     * they will resolve one after another until one of them does not skip the
     * update. The conversation will only skip an update when all concurrent
     * wait calls skip the update. Specifying `next` for a skip call that is not
     * the final skip call has no effect.
     *
     * @param options Optional options to control middleware resumption
     */
    async skip(options: SkipOptions = {}): Promise<never> {
        const next = "next" in options ? options.next : this.options.parallel;
        return await this.controls.cancel(next ? "skip" : "drop");
    }
    /**
     * Calls any exit handlers if installed, and then terminates the
     * conversation immediately. This method never returns.
     *
     * By default, this will consume the update. Pass `{ next: true }` to make
     * sure that downstream middleware is called.
     *
     * @param options Optional options to control middleware resumption
     */
    async halt(options: HaltOptions = {}): Promise<never> {
        await this.options.onHalt?.();
        return await this.controls.cancel(options.next ? "kill" : "halt");
    }
    /**
     * Creates a new checkpoint at the current point of the conversation.
     *
     * This checkpoint can be passed to `rewind` in order to go back in the
     * conversation and resume it from an earlier point.
     *
     * ```ts
     * const check = conversation.checkpoint();
     *
     * // Later:
     * await conversation.rewind(check);
     * ```
     */
    checkpoint(): Checkpoint {
        return this.controls.checkpoint();
    }
    /**
     * Rewinds the conversation to a previous point and continues execution from
     * there. This point is specified by a checkpoint that can be created by
     * calling {@link Conversation.checkpoint}.
     *
     * ```ts
     * const check = conversation.checkpoint();
     *
     * // Later:
     * await conversation.rewind(check);
     * ```
     *
     * @param checkpoint A previously created checkpoint
     */
    async rewind(checkpoint: Checkpoint): Promise<never> {
        return await this.controls.cancel(checkpoint);
    }
    /**
     * Runs a function outside of the replay engine. This provides a safe way to
     * perform side-effects such as database communication, disk operations,
     * session access, file downloads, requests to external APIs, randomness,
     * time-based functions, and more. **It requires any data obtained from the
     * outside to be serializable.**
     *
     * Remember that a conversation function is not executed like a normal
     * JavaScript function. Instead, it is often interrupted and replayed,
     * sometimes many times for the same update. If this is not obvious to you,
     * it means that you probably should read [the documentation of this
     * plugin](https://grammy.dev/plugins/conversations) in order to avoid
     * common pitfalls.
     *
     * For instance, if you want to access to your database, you only want to
     * read or write data once, rather than doing it once per replay. `external`
     * provides an escape hatch to this situation. You can wrap your database
     * call inside `external` to mark it as something that performs
     * side-effects. The replay engine inside the conversations plugin will then
     * make sure to only execute this operation once. This looks as follows.
     *
     * ```ts
     * // Read from database
     * const data = await conversation.external(async () => {
     *   return await readFromDatabase()
     * })
     *
     * // Write to database
     * await conversation.external(async () => {
     *   await writeToDatabase(data)
     * })
     * ```
     *
     * When `external` is called, it returns whichever data the given callback
     * function returns. Note that this data has to be persisted by the plugin,
     * so you have to make sure that it can be serialized. The data will be
     * stored in the storage backend you provided when installing the
     * conversations plugin via `bot.use`. In particular, it does not work well
     * to return objects created by an ORM, as these objects have functions
     * installed on them which will be lost during serialization.
     *
     * As a rule of thumb, imagine that all data from `external` is passed
     * through `JSON.parse(JSON.stringify(data))` (even though this is not what
     * actually happens under the hood).
     *
     * The callback function passed to `external` received the outside context
     * object from the current middleware pass. This lets you access properties
     * on the context object that are only present in the outside middleware
     * system, but that have not been installed on the context objects inside a
     * conversation. For example, you can access your session data this way.
     *
     * ```ts
     * // Read from session
     * const data = await conversation.external((ctx) => {
     *   return ctx.session.data
     * })
     *
     * // Write to session
     * await conversation.external((ctx) => {
     *   ctx.session.data = data
     * })
     * ```
     *
     * Note that while a call to `external` is running, you cannot do any of the
     * following things.
     *
     * - start a concurrent call to `external` from the same conversation
     * - start a nested call to `external` from the same conversation
     * - start a Bot API call from the same conversation
     *
     * Naturally, it is possible to have several concurrent calls to `externals`
     * if they happen in unrelated chats. This still means that you should keep
     * the code inside `external` to a minimum and actually only perform the
     * desired side-effect itself.
     *
     * If you want to return data from `external` that cannot be serialized, you
     * can specify a custom serialization function. This allows you choose a
     * different intermediate data representation during storage than what is
     * present at runtime.
     *
     * ```ts
     * // Read bigint from an API but persist it as a string
     * const largeNumber: bigint = await conversation.external({
     *   task: () => fetchCoolBigIntFromTheInternet(),
     *   beforeStore: (largeNumber) => String(largeNumber),
     *   afterLoad: (str) => BigInt(str),
     * })
     * ```
     *
     * Note how we read a bigint from the internet, but we convert it to string
     * during persistence. This now allows us to use a storage adapter that only
     * handles strings but does not need to support the bigint type.
     *
     * @param op An operation to perform outside of the conversation
     */
    // deno-lint-ignore no-explicit-any
    async external<R, I = any>(
        op: ExternalOp<OC, R, I>["task"] | ExternalOp<OC, R, I>,
    ): Promise<R> {
        // Make sure that no other ops are performed concurrently (or from
        // within the handler) because they will not be performed during a
        // replay so they will be missing from the logs then, which clogs up the
        // replay. This detection must be done here because this is the only
        // place where misuse can be detected properly. The replay engine cannot
        // discover that on its own because otherwise it would not support
        // concurrent ops at all, which is undesired.
        if (this.insideExternal) {
            throw new Error(
                "Cannot perform nested or concurrent calls to `external`!",
            );
        }

        const {
            task,
            afterLoad = (x: I) => x as unknown as R,
            afterLoadError = (e: unknown) => e,
            beforeStore = (x: R) => x as unknown as I,
            beforeStoreError = (e: unknown) => e,
        } = typeof op === "function" ? { task: op } : op;
        // Prepare values before storing them
        const action = async () => {
            this.insideExternal = true;
            try {
                // We perform an unsafe cast to the context type used in the
                // surrounding middleware system. Technically, we could drag
                // this type along from outside by adding an extra type
                // parameter everywhere, but this makes all types too cumbersome
                // to work with for bot developers. The benefits of this
                // massively reduced complexity outweight the potential benefits
                // of slightly stricter types for `external`.
                const ret = await this.escape((ctx) => task(ctx));
                return { ok: true, ret: await beforeStore(ret) } as const;
            } catch (e) {
                return { ok: false, err: await beforeStoreError(e) } as const;
            } finally {
                this.insideExternal = false;
            }
        };
        // Recover values after loading them
        const ret = await this.controls.action(action, "external");
        if (ret.ok) {
            return await afterLoad(ret.ret);
        } else {
            throw await afterLoadError(ret.err);
        }
    }
    /**
     * Takes `Date.now()` once when reached, and returns the same value during
     * every replay. Prefer this over calling `Date.now()` directly.
     */
    async now() {
        return await this.external(() => Date.now());
    }
    /**
     * Takes `Math.random()` once when reached, and returns the same value
     * during every replay. Prefer this over calling `Math.random()` directly.
     */
    async random() {
        return await this.external(() => Math.random());
    }
    /**
     * Calls `console.log` only the first time it is reached, but not during
     * subsequent replays. Prefer this over calling `console.log` directly.
     */
    async log(...data: unknown[]) {
        await this.external(() => console.log(...data));
    }
    /**
     * Calls `console.error` only the first time it is reached, but not during
     * subsequent replays. Prefer this over calling `console.error` directly.
     */
    async error(...data: unknown[]) {
        await this.external(() => console.error(...data));
    }

    /**
     * Creates a new conversational menu.
     *
     * A conversational menu is a an interactive inline keyboard that is sent to
     * the user from within a conversation.
     *
     * ```ts
     * const menu = conversation.menu()
     *   .text("Send message", ctx => ctx.reply("Hi!"))
     *   .text("Close", ctx => ctx.menu.close())
     *
     * await ctx.reply("Menu message", { reply_markup: menu })
     * ```
     *
     * If a menu identifier is specified, conversational menus enable seamless
     * navigation.
     *
     * ```ts
     * const menu = conversation.menu("root")
     *   .submenu("Open submenu", ctx => ctx.editMessageText("submenu"))
     *   .text("Close", ctx => ctx.menu.close())
     * conversation.menu("child", { parent: "root" })
     *   .back("Go back", ctx => ctx.editMessageText("Root menu"))
     *
     * await ctx.reply("Root menu", { reply_markup: menu })
     * ```
     *
     * You can also interact with the conversation from inside button handlers.
     *
     * ```ts
     * let name = ""
     * const menu = conversation.menu()
     *   .text("Set name", async ctx => {
     *     await ctx.reply("What's your name?")
     *     name = await conversation.form.text()
     *     await ctx.editMessageText(name)
     *   })
     *   .text("Clear name", ctx => {
     *     name = ""
     *     await ctx.editMessageText("No name")
     *   })
     *
     * await ctx.reply("No name (yet)", { reply_markup: menu })
     * ```
     *
     * More information about conversational menus can be found [in the
     * documentation](https://grammy.dev/plugins/conversations).
     *
     * @param id Optional menu identifier
     * @param options Optional menu options
     */
    menu(id?: string, options?: Partial<ConversationMenuOptions<C>>) {
        return this.menuPool.create(id, options);
    }
    /**
     * A namespace full of various utitilies for building forms.
     *
     * Typically, `wait` calls return context objects. Optionally, these context
     * objects can be accepted or rejected based on validation, such as with
     * `waitFor` which only returns context objects matching a given filter
     * query.
     *
     * Forms add another level of convenience on top of this. They no longer
     * require you to deal with context objects. Each form field performs both
     * validation and selection. This means that it picks out certain property
     * from the context object—such as the message text—and returns this
     * property directly.
     *
     * As an example, here is how you can wait for a number using the form field
     * `.number`.
     *
     * ```ts
     * // Wait for a number
     * const n = await conversation.form.number()
     * // Send back its square
     * await ctx.reply(`The square of ${n} is ${n * n}!`)
     * ```
     *
     * There are many more form fields that let you wait for virtually any type
     * of message content.
     *
     * All form fields give you the option to perform an action if the
     * validation fails by accepting an `otherwise` function. This is similar to
     * filtered wait calls.
     *
     * ```ts
     * const text = await conversation.form.select(["Yes", "No"], {
     *   otherwise: ctx => ctx.reply("Please send Yes or No.")
     * })
     * ```
     *
     * In addition, all form fields give you the option to perform some action
     * when a value is accepted. For example, this is how you can delete
     * incoming messages.
     *
     * ```ts
     * const text = await conversation.form.select(["Yes", "No"], {
     *   action: ctx => ctx.deleteMessage()
     * })
     * ```
     *
     * Note that either `otherwise` or `action` will be called, but never both
     * for the same update.
     */
    form = new ConversationForm(this);
}

/** A promise that also contains methods for chaining filtered wait calls */
export type AndPromise<C extends Context> = Promise<C> & AndExtension<C>;
/** A container for methods that filter wait calls */
export interface AndExtension<C extends Context> {
    /**
     * Filters down the wait call using another custom predicate function.
     * Corresponds with {@link Conversation.waitUntil}.
     *
     * @param predicate An extra predicate function to check
     * @param opts Optional options object
     */
    and<D extends C>(
        predicate: (ctx: C) => ctx is D,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<D>;
    and(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<C>;
    /**
     * Filters down the wait call using another negated custom predicate
     * function. Corresponds with {@link Conversation.waitUnless}.
     *
     * @param predicate An extra predicate function to check
     * @param opts Optional options object
     */
    unless(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<C>;
    /**
     * Filters down the wait call using another filter query. Corresponds with
     * {@link Conversation.waitFor}.
     *
     * @param query An extra filter query to check
     * @param opts Optional options object
     */
    andFor<Q extends FilterQuery>(
        query: Q | Q[],
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<Filter<C, Q>>;
    /**
     * Filters down the wait call using another hears check. Corresponds with
     * {@link Conversation.waitForHears}.
     *
     * @param trigger An extra text to look for
     * @param opts Optional options object
     */
    andForHears(
        trigger: MaybeArray<string | RegExp>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<HearsContext<C>>;
    /**
     * Filters down the wait call using another command check. Corresponds with
     * {@link Conversation.waitForCommand}.
     *
     * @param command An extra command to look for
     * @param opts Optional options object
     */
    andForCommand(
        command: MaybeArray<StringWithCommandSuggestions>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<CommandContext<C>>;
    /**
     * Filters down the wait call using another reaction check. Corresponds with
     * {@link Conversation.waitForReaction}.
     *
     * @param reaction An extra reaction to look for
     * @param opts Optional options object
     */
    andForReaction(
        reaction: MaybeArray<ReactionTypeEmoji["emoji"] | ReactionType>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<ReactionContext<C>>;
    /**
     * Filters down the wait call using another callback query check.
     * Corresponds with {@link Conversation.waitForCallbackQuery}.
     *
     * @param trigger An extra callback query to look for
     * @param opts Optional options object
     */
    andForCallbackQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<CallbackQueryContext<C>>;
    /**
     * Filters down the wait call using another game query check. Corresponds
     * with {@link Conversation.waitForGameQuery}.
     *
     * @param trigger An extra game query to look for
     * @param opts Optional options object
     */
    andForGameQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<GameQueryContext<C>>;
    /**
     * Filters down the wait call using another check for a user. Corresponds
     * with {@link Conversation.waitFrom}.
     *
     * @param user An extra user to look for
     * @param opts Optional options object
     */
    andFrom(
        user: number | User,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<C & { from: User }>;
    /**
     * Filters down the wait call using another check for a reply. Corresponds
     * with {@link Conversation.waitForReplyTo}.
     *
     * @param message_id An extra message to look for in a reply
     * @param opts Optional options object
     */
    andForReplyTo(
        message_id: number | { message_id: number },
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<Filter<C, "message" | "channel_post">>;
}

function makeAndCombiner(
    conversation: { skip: (opts: SkipOptions) => Promise<never> },
) {
    return function combineAnd<C extends Context>(
        promise: Promise<C>,
    ): AndPromise<C> {
        const ext: AndExtension<C> = {
            and(
                predicate: (ctx: C) => boolean | Promise<boolean>,
                opts: AndOtherwiseOptions<C> = {},
            ) {
                const { otherwise, ...skipOptions } = opts;
                return combineAnd(promise.then(async (ctx) => {
                    if (!await predicate(ctx)) {
                        await otherwise?.(ctx);
                        await conversation.skip(skipOptions);
                    }
                    return ctx;
                }));
            },
            unless(predicate, opts) {
                return ext.and(async (ctx) => !await predicate(ctx), opts);
            },
            andFor(query, opts) {
                return ext.and(Context.has.filterQuery(query), opts);
            },
            andForHears(trigger, opts) {
                return ext.and(Context.has.text(trigger), opts);
            },
            andForCommand(command, opts) {
                return ext.and(Context.has.command(command), opts);
            },
            andForReaction(reaction, opts) {
                return ext.and(Context.has.reaction(reaction), opts);
            },
            andForCallbackQuery(trigger, opts) {
                return ext.and(Context.has.callbackQuery(trigger), opts);
            },
            andForGameQuery(trigger, opts) {
                return ext.and(Context.has.gameQuery(trigger), opts);
            },
            andFrom(user, opts) {
                const id = typeof user === "number" ? user : user.id;
                return ext.and(
                    (ctx): ctx is C & { from: User } => ctx.from?.id === id,
                    opts,
                );
            },
            andForReplyTo(message_id, opts) {
                const id = typeof message_id === "number"
                    ? message_id
                    : message_id.message_id;
                return ext.and(
                    (ctx): ctx is Filter<C, "message" | "channel_post"> =>
                        ctx.message?.reply_to_message?.message_id === id ||
                        ctx.channelPost?.reply_to_message?.message_id === id,
                    opts,
                );
            },
        };
        return Object.assign(promise, ext);
    };
}
