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
import { type ReplayControls, ReplayEngine } from "./engine.ts";
import { type ReplayState } from "./state.ts";
export type { Conversation } from "./conversation.ts";

const internalRecursionDetection = Symbol("conversations.recursion");
const internalMutableState = Symbol("conversations.data");
const internalIndex = Symbol("conversations.builders");
const internalDefaultPlugins = Symbol("conversations.plugins");
const internalExitHandler = Symbol("conversations.exit");
const internalCompletenessMarker = Symbol("conversations.completeness");

export interface ContextBaseData {
    update: Update;
    api: ApiBaseData;
    me: UserFromGetMe;
}
export interface ApiBaseData {
    token: string;
    options?: ApiClientOptions;
}

type MaybePromise<T> = T | Promise<T>;
export type ConversationStorage<C extends Context> =
    | ConversationContextStorage<C>
    | ConversationKeyStorage<C>;
export interface ConversationContextStorage<C extends Context> {
    adapter?: never;

    read(ctx: C): MaybePromise<ConversationData | undefined>;
    write(ctx: C, state: ConversationData): MaybePromise<void>;
    delete(ctx: C): MaybePromise<void>;
}
export interface ConversationKeyStorage<C extends Context> {
    getStorageKey(ctx: C): string | undefined;
    adapter: {
        read(key: string): MaybePromise<ConversationData | undefined>;
        write(key: string, state: ConversationData): MaybePromise<void>;
        delete(key: string): MaybePromise<void>;
    };

    read?: never;
    write?: never;
    delete?: never;
}
export interface ConversationOptions<OC extends Context, C extends Context> {
    storage?: ConversationStorage<OC>;
    plugins?: Middleware<C>[];
    onEnter?(id: string): MaybePromise<unknown>;
    onExit?(id: string): MaybePromise<unknown>;
}
function defaultStorage<C extends Context>(): ConversationKeyStorage<C> {
    const store = new Map<string, ConversationData>();
    return {
        getStorageKey: (ctx) => ctx.chatId?.toString(),
        adapter: {
            read: (key) => store.get(key),
            write: (key, state) => void store.set(key, state),
            delete: (key) => void store.delete(key),
        },
    };
}
function uniformStorage<C extends Context>(
    storage: ConversationStorage<C> = defaultStorage(),
) {
    if ("getStorageKey" in storage) {
        return (ctx: C) => {
            const key = storage.getStorageKey(ctx);
            return key === undefined
                ? {
                    read: () => undefined,
                    write: () => undefined,
                    delete: () => undefined,
                }
                : {
                    read: () => storage.adapter.read(key),
                    write: (state: ConversationData) =>
                        storage.adapter.write(key, state),
                    delete: () => storage.adapter.delete(key),
                };
        };
    } else {
        return (ctx: C) => {
            return {
                read: () => storage.read(ctx),
                write: (state: ConversationData) => storage.write(ctx, state),
                delete: () => storage.delete(ctx),
            };
        };
    }
}
export interface ConversationData {
    [id: string]: ConversationState[];
}
type ConversationIndex<C extends Context> = Map<
    string,
    ConversationIndexEntry<C>
>;
interface ConversationIndexEntry<C extends Context> {
    builder: ConversationBuilder<C>;
    plugins: Middleware<C>[];
    maxMillisecondsToWait: number | undefined;
}
export type ConversationFlavor<C extends Context> = C & {
    conversation: ConversationControls;
};
export interface ConversationControls {
    enter(
        name: string,
        options?: { parallel?: boolean; args?: unknown[] },
    ): Promise<void>;
    exit(name: string): Promise<void>;
    exitAll(): Promise<void>;
    exitOne(name: string, index: number): Promise<void>;
    active(): Record<string, number>;
    active(name: string): number;
}
function controls(
    getData: () => ConversationData,
    canSave: () => boolean,
    enter: (name: string, ...args: unknown[]) => Promise<EnterResult>,
    exit?: (name: string) => Promise<void>,
): ConversationControls {
    async function fireExit(events: string[]) {
        if (exit === undefined) return;
        const len = events.length;
        for (let i = 0; i < len; i++) {
            await exit(events[i]);
        }
    }

    return {
        async enter(name, options) {
            if (!canSave()) {
                throw new Error(
                    "The middleware has already completed so it is no longer possible to enter a conversation",
                );
            }
            const data = getData();
            if (Object.keys(data).length > 0 && !options?.parallel) {
                throw new Error("This conversation was already entered");
            }
            data[name] ??= [];
            const result = await enter(name, ...options?.args ?? []);
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
                    const state: ConversationState = {
                        args: result.args,
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
        if (internalMutableState in ctx) {
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

        const index: ConversationIndex<C> = new Map();
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
            await options.onEnter?.(id);
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
                await options.onExit?.(name);
            }
            : undefined;

        function canSave() {
            return !(internalCompletenessMarker in ctx);
        }

        Object.defineProperty(ctx, internalMutableState, { get: getData });
        Object.defineProperty(ctx, internalIndex, { value: index });
        Object.defineProperty(ctx, internalDefaultPlugins, {
            value: options.plugins ?? [],
        });
        Object.defineProperty(ctx, internalExitHandler, { get: () => exit });
        Object.defineProperty(ctx, "conversation", {
            value: controls(getData, canSave, enter, exit),
        });
        await next();
        Object.defineProperty(ctx, internalCompletenessMarker, { value: true });
        if (read) {
            // In case of bad usage of async/await, it is possible that `next`
            // resolves while an enter call is still running. It then may not
            // have cleaned up its data, leaving behind empty arrays on the
            // state. Instead of delegating the cleanup responsibility to enter
            // calls which are unable to do this reliably, we purge empty arrays
            // ourselves before persisting the state. That way, we don't store
            // useless data even when bot developers mess up.
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
    };
}

export interface ConversationState {
    args: string;
    replay: ReplayState;
    interrupts: number[];
}
export type ConversationResult =
    | ConversationComplete
    | ConversationError
    | ConversationHandled
    | ConversationSkipped;
export interface ConversationComplete {
    status: "complete";
    proceed: boolean;
}
export interface ConversationError {
    status: "error";
    error: unknown;
}
export interface ConversationHandled {
    status: "handled";
    replay: ReplayState;
    interrupts: number[];
}
export interface ConversationSkipped {
    status: "skipped";
}

export type ConversationBuilder<C extends Context> = (
    conversation: Conversation<C>,
    ctx: C,
    // deno-lint-ignore no-explicit-any
    ...args: any[]
) => void | Promise<void>;
export interface ConversationConfig<C extends Context> {
    id?: string;
    plugins?: Middleware<C>[];
    maxMillisecondsToWait?: number;
    seal?: boolean;
}

export function createConversation<OC extends Context, C extends Context>(
    builder: ConversationBuilder<C>,
    options?: string | ConversationConfig<C>,
): MiddlewareFn<ConversationFlavor<OC>> {
    const {
        id = builder.name,
        plugins = [],
        maxMillisecondsToWait = undefined,
        seal = false,
    } = typeof options === "string" ? { id: options } : options ?? {};
    if (!id) {
        throw new Error("Cannot register a conversation without a name!");
    }
    return async (ctx, next) => {
        if (
            !(internalMutableState in ctx) ||
            !(internalIndex in ctx) ||
            !(internalDefaultPlugins in ctx) ||
            !(internalExitHandler in ctx)
        ) {
            throw new Error(
                "Cannot register a conversation without installing the conversations plugin first!",
            );
        }

        const index = ctx[internalIndex] as ConversationIndex<C>;
        if (index.has(id)) {
            throw new Error(`Duplicate conversation identifier '${id}'!`);
        }
        const defaultPlugins = ctx[internalDefaultPlugins] as Middleware<C>[];
        const combinedPlugins = [...defaultPlugins, ...plugins];
        index.set(id, {
            builder,
            plugins: combinedPlugins,
            maxMillisecondsToWait,
        });
        const onExit = ctx[internalExitHandler] as
            | ((name: string) => MaybePromise<unknown>)
            | undefined;
        const onHalt = async () => {
            await onExit?.(id);
        };

        const mutableData = ctx[internalMutableState] as ConversationData;
        const base: ContextBaseData = {
            update: ctx.update,
            api: ctx.api,
            me: ctx.me,
        };
        const options: ResumeOptions<C> = {
            ctx,
            plugins: combinedPlugins,
            onHalt,
            maxMillisecondsToWait,
            seal,
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
                if (result.proceed) await next();
                return;
            case "error":
                throw result.error;
            case "skipped":
                await next();
                return;
            case "handled":
                return;
        }
    };
}

export async function runParallelConversations<C extends Context>(
    builder: ConversationBuilder<C>,
    base: ContextBaseData,
    id: string,
    data: ConversationData,
    options?: ResumeOptions<C>,
): Promise<ConversationResult> {
    if (!(id in data)) return { status: "skipped" };
    const states = data[id];
    const len = states.length;
    for (let i = 0; i < len; i++) {
        const state = states[i];
        const result = await resumeConversation(builder, base, state, options);
        switch (result.status) {
            case "skipped":
                continue;
            case "handled":
                states[i].replay = result.replay;
                states[i].interrupts = result.interrupts;
                return result;
            case "complete":
                states.splice(i, 1);
                if (states.length === 0) delete data[id];
                if (result.proceed) continue;
                else return result;
            case "error":
                states.splice(i, 1);
                if (states.length === 0) delete data[id];
                return result;
        }
    }
    return { status: "skipped" };
}

export type EnterResult =
    | EnterComplete
    | EnterError
    | EnterHandled
    | EnterSkipped;
export type EnterComplete = ConversationComplete;
export type EnterError = ConversationError;
export interface EnterHandled extends ConversationHandled {
    args: string;
}
export interface EnterSkipped extends ConversationSkipped {
    args: string;
    replay: ReplayState;
    interrupts: number[];
}

export interface EnterOptions<C extends Context> extends ResumeOptions<C> {
    args?: unknown[];
}
export async function enterConversation<C extends Context>(
    conversation: ConversationBuilder<C>,
    base: ContextBaseData,
    options?: EnterOptions<C>,
): Promise<EnterResult> {
    const { args = [], ...opts } = options ?? {};
    const packedArgs = JSON.stringify(args);
    const [initialState, int] = ReplayEngine.open();
    const state: ConversationState = {
        args: packedArgs,
        replay: initialState,
        interrupts: [int],
    };
    const result = await resumeConversation(conversation, base, state, opts);
    switch (result.status) {
        case "complete":
        case "error":
            return result;
        case "handled":
            return { args: packedArgs, ...result };
        case "skipped":
            return {
                args: packedArgs,
                replay: initialState,
                interrupts: state.interrupts,
                ...result,
            };
    }
}

export interface ResumeOptions<C extends Context> {
    ctx?: Context;
    plugins?: Middleware<C>[];
    onHalt?: () => MaybePromise<void>;
    maxMillisecondsToWait?: number;
    seal?: boolean;
}
export async function resumeConversation<C extends Context>(
    conversation: ConversationBuilder<C>,
    base: ContextBaseData,
    state: ConversationState,
    options?: ResumeOptions<C>,
): Promise<ConversationResult> {
    const { update, api, me } = base;
    const args = JSON.parse(state.args);
    const {
        ctx = youTouchYouDie<C>(
            "The conversation was advanced from an event so there is no access to an outside context object",
        ),
        plugins = [],
        onHalt,
        maxMillisecondsToWait,
        seal,
    } = options ?? {};
    const middleware = new Composer(...plugins).middleware();
    // deno-lint-ignore no-explicit-any
    const escape = (fn: (ctx: Context) => any) => fn(ctx);
    const engine = new ReplayEngine(async (controls) => {
        const hydrate = hydrateContext<C>(controls, api, me);
        const convo = new Conversation(controls, hydrate, escape, middleware, {
            onHalt,
            maxMillisecondsToWait,
            seal,
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
    for (let i = 0; i < len; i++) {
        const int = ints[i];
        const checkpoint = ReplayEngine.supply(replayState, int, update);
        const result = await engine.replay(replayState);
        switch (result.type) {
            case "returned":
                // tell caller that we are done, all good
                return { status: "complete", proceed: false };
            case "thrown":
                // tell caller that an error was thrown, it should leave the
                // conversation and rethrow the error
                return { status: "error", error: result.error };
            // TODO: disable lint until the following issue is fixed:
            // https://github.com/denoland/deno_lint/issues/1331
            // deno-lint-ignore no-fallthrough
            case "interrupted":
                // check the type of interrupt by inspecting its message
                switch (result.message) {
                    case "skip":
                        // current interrupt was skipped, replay again with the next
                        ReplayEngine.reset(replayState, checkpoint);
                        continue;
                    case "drop":
                        // drop the update, do not modify the state
                        ReplayEngine.reset(replayState, checkpoint);
                        return {
                            status: "handled",
                            replay: replayState,
                            interrupts: ints,
                        };
                    case "halt":
                        // tell caller that we are done, all good
                        return { status: "complete", proceed: false };
                    case "kill":
                        // tell the called that we are done and that downstream
                        // middleware must be called
                        return { status: "complete", proceed: true };
                    case undefined:
                        // tell caller that we handled the update and updated the state
                        return {
                            status: "handled",
                            replay: result.state,
                            interrupts: result.interrupts,
                        };
                    default:
                        throw new Error("never"); // cannot happen
                }
            default:
                throw new Error("never"); // cannot happen
        }
    }
    // tell caller that we want to skip the update and did not modify the state
    return { status: "skipped" };
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
            const ret = await controls.action(action);
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

function youTouchYouDie<T extends object>(msg: string) {
    function nope(): never {
        throw new Error(msg);
    }
    return new Proxy({} as T, {
        apply: nope,
        construct: nope,
        defineProperty: nope,
        deleteProperty: nope,
        get: nope,
        getOwnPropertyDescriptor: nope,
        getPrototypeOf: nope,
        has: nope,
        isExtensible: nope,
        ownKeys: nope,
        preventExtensions: nope,
        set: nope,
        setPrototypeOf: nope,
    });
}
