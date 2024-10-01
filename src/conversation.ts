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
type MaybeArray<T> = T | T[];
export type StringWithCommandSuggestions =
    | (string & Record<never, never>)
    | "start"
    | "help"
    | "settings"
    | "privacy"
    | "developer_info";

// deno-lint-ignore no-explicit-any
export interface ExternalOp<OC extends Context, R, I = any> {
    task: (ctx: OC) => R | Promise<R>;
    beforeStore?: (value: R) => I | Promise<I>;
    afterLoad?: (value: I) => R | Promise<R>;
    beforeStoreError?: (value: unknown) => unknown | Promise<unknown>;
    afterLoadError?: (value: unknown) => unknown | Promise<unknown>;
}
type ApplyContext = <F extends (ctx: Context) => unknown>(
    fn: F,
) => Promise<ReturnType<F>>;

export interface ConversationHandleOptions {
    onHalt?(): void | Promise<void>;
    maxMillisecondsToWait?: number;
    seal?: boolean;
}

export interface WaitOptions {
    maxMilliseconds?: number;
    collationKey?: string;
}
export interface SkipOptions {
    drop?: boolean;
}
export interface AndOtherwiseOptions<C extends Context> extends SkipOptions {
    otherwise?: (ctx: C) => unknown | Promise<unknown>;
}
export interface OtherwiseOptions<C extends Context>
    extends WaitOptions, AndOtherwiseOptions<C> {}

export interface HaltOptions {
    proceed?: boolean;
}

export class Conversation<C extends Context = Context> {
    /** true if external is currently running, false otherwise */
    private insideExternal = false;
    private combineAnd = makeAndCombiner(this);
    constructor(
        private controls: ReplayControls,
        private hydrate: (update: Update) => C,
        private escape: ApplyContext,
        private middleware: MiddlewareFn<C>,
        private options: ConversationHandleOptions,
    ) {}
    // TODO: add menus
    wait(options: WaitOptions = {}): AndPromise<C> {
        if (this.insideExternal) {
            throw new Error(
                "Cannot wait for updates from inside `external`, or concurrently to it! \
First return your data from `external` and then resume update handling using `wait` calls.",
            );
        }
        const makeWait = async () => {
            const limit = "maxMilliseconds" in options
                ? options.maxMilliseconds
                : this.options.maxMillisecondsToWait;
            const key = options.collationKey ?? "wait";
            const before = limit !== undefined && await this.now();
            const update = await this.controls.interrupt(key) as Update;
            if (before !== false) {
                const after = await this.now();
                if (after - before >= limit) {
                    await this.halt({ proceed: true });
                }
            }

            const ctx = this.hydrate(update);
            let nextCalled = false;
            await this.middleware(ctx, () => {
                nextCalled = true;
                return Promise.resolve();
            });
            // If a plugin decided to handle the update (did not call `next`), then
            // we recurse and simply wait for another update.
            return nextCalled ? ctx : await this.wait(options);
        };
        return this.combineAnd(makeWait());
    }
    async skip(options: SkipOptions = {}): Promise<never> {
        const drop = "drop" in options ? options.drop : this.options.seal;
        return await this.controls.cancel(drop ? "drop" : "skip");
    }
    async halt(options?: HaltOptions): Promise<never> {
        await this.options.onHalt?.();
        return await this.controls.cancel(options?.proceed ? "kill" : "halt");
    }
    checkpoint(): Checkpoint {
        return this.controls.checkpoint();
    }
    async rewind(checkpoint: Checkpoint): Promise<never> {
        return await this.controls.cancel(checkpoint);
    }
    // deno-lint-ignore no-explicit-any
    async external<OC extends Context, R, I = any>(
        op: ExternalOp<OC, R, I>["task"] | ExternalOp<OC, R, I>,
    ): Promise<R> {
        // Make sure that no other ops are performed concurrently (or from
        // within the handler) because they will not be performed during a
        // replay so they will be missing from the logs then, which clogs up
        // the replay. This detection must be done here because this is the
        // only place where misuse can be detected properly. The replay
        // engine cannot discover that on its own because otherwise it would
        // not support concurrent ops at all, which is undesired.
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
                const ret = await this.escape((ctx) => task(ctx as OC));
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
    async now() {
        return await this.external(() => Date.now());
    }
    async random() {
        return await this.external(() => Math.random());
    }
    async log(...data: unknown[]) {
        await this.external(() => console.log(...data));
    }
    async error(...data: unknown[]) {
        await this.external(() => console.error(...data));
    }

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
            const { otherwise, drop, ...waitOptions } = opts;
            const ctx = await this.wait({
                collationKey: "until",
                ...waitOptions,
            });
            if (!await predicate(ctx)) {
                await otherwise?.(ctx);
                await this.skip({ drop });
            }
            return ctx;
        };
        return this.combineAnd(makeWait());
    }
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
    waitForHears(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<HearsContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.text(trigger), {
            collationKey: "hears",
            ...opts,
        }));
    }
    waitForCommand(
        command: MaybeArray<StringWithCommandSuggestions>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<CommandContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.command(command), {
            collationKey: "command",
            ...opts,
        }));
    }
    waitForReaction(
        reaction: MaybeArray<ReactionTypeEmoji["emoji"] | ReactionType>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<ReactionContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.reaction(reaction), {
            collationKey: "reaction",
            ...opts,
        }));
    }
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
    waitForGameQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: OtherwiseOptions<C>,
    ): AndPromise<GameQueryContext<C>> {
        return this.combineAnd(this.waitUntil(Context.has.gameQuery(trigger), {
            collationKey: "game",
            ...opts,
        }));
    }
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

    form = new ConversationForm(this);
}

export type AndPromise<C extends Context> = Promise<C> & AndExtension<C>;
export interface AndExtension<C extends Context> {
    and<D extends C>(
        predicate: (ctx: C) => ctx is D,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<D>;
    and(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<C>;
    unless(
        predicate: (ctx: C) => boolean | Promise<boolean>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<C>;
    andFor<Q extends FilterQuery>(
        query: Q | Q[],
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<Filter<C, Q>>;
    andForHears(
        trigger: MaybeArray<string | RegExp>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<HearsContext<C>>;
    andForCommand(
        command: MaybeArray<StringWithCommandSuggestions>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<CommandContext<C>>;
    andForReaction(
        reaction: MaybeArray<ReactionTypeEmoji["emoji"] | ReactionType>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<ReactionContext<C>>;
    andForCallbackQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<CallbackQueryContext<C>>;
    andForGameQuery(
        trigger: MaybeArray<string | RegExp>,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<GameQueryContext<C>>;
    andFrom(
        user: number | User,
        opts?: AndOtherwiseOptions<C>,
    ): AndPromise<C & { from: User }>;
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
