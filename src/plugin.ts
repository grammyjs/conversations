import { Conversation } from "./conversation.ts";
import {
    Api,
    Context,
    HttpError,
    type MiddlewareFn,
    type Update,
    type UserFromGetMe,
} from "./deps.deno.ts";
import { type ReplayControls, ReplayEngine } from "./engine.ts";
import { type ReplayState } from "./state.ts";

const internalRecursionDetection = Symbol("conversations.recursion");
const internalMutableState = Symbol("conversations.data");
const internalIndex = Symbol("conversations.builders");
const internalCompletenessMarker = Symbol("conversations.completeness");

export interface ContextBaseData {
    update: Update;
    api: Api;
    me: UserFromGetMe;
}

type MaybePromise<T> = T | Promise<T>;
export type ConversionStorage<C extends Context> =
    | ConversationContextStorage<C>
    | ConversationKeyStorage<C>;
export interface ConversationContextStorage<C extends Context> {
    read(ctx: C): MaybePromise<ConversationData | undefined>;
    write(ctx: C, state: ConversationData): MaybePromise<void>;
    delete(ctx: C): MaybePromise<void>;
}
export interface ConversationKeyStorage<C extends Context> {
    getStorageKey(ctx: C): string;
    read(key: string): MaybePromise<ConversationData | undefined>;
    write(key: string, state: ConversationData): MaybePromise<void>;
    delete(key: string): MaybePromise<void>;
}
export interface ConversationOptions<C extends Context> {
    storage: ConversionStorage<C>;
    onEnter?(id: string): MaybePromise<unknown>;
    onExit?(id: string): MaybePromise<unknown>;
}
function uniformStorage<C extends Context>(storage: ConversionStorage<C>) {
    if ("getStorageKey" in storage) {
        return (ctx: C) => {
            const key = storage.getStorageKey(ctx);
            return {
                read: () => storage.read(key),
                write: (state: ConversationData) => storage.write(key, state),
                delete: () => storage.delete(key),
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
type ConversationIndex<C extends Context> = Map<string, ConversationBuilder<C>>;
export type ConversationContext<C extends Context> = C & {
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
    // deno-lint-ignore no-explicit-any
    enter: (name: string, ...args: any[]) => Promise<EnterResult>,
    exit?: (name: string) => Promise<void>,
): ConversationControls {
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
            const data = getData();
            const keys = Object.keys(data);
            const len = keys.length;
            let count = 0;
            for (let i = 0; i < len; i++) {
                const key = keys[i];
                count += data[key].length;
                delete data[key];
            }
            if (exit !== undefined) {
                for (let i = 0; i < len; i++) {
                    await exit(name);
                }
            }
        },
        async exit(name) {
            const data = getData();
            if (data[name] === undefined) return;
            const len = data[name].length;
            delete data[name];
            if (exit !== undefined) {
                for (let i = 0; i < len; i++) {
                    await exit(name);
                }
            }
        },
        async exitOne(name, index) {
            const data = getData();
            if (
                data[name] === undefined ||
                index < 0 || data[name].length <= index
            ) return;
            data[name].splice(index, 1);
            if (exit !== undefined) {
                await exit(name);
            }
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

export function conversations<C extends Context>(
    options: ConversationOptions<C>,
): MiddlewareFn<ConversationContext<C>> {
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
        const res = await storage.read();
        if (res === undefined) {
            await next();
            return;
        }
        const state = res;
        const empty = Object.keys(state).length === 0;
        function getData() {
            read = true;
            return state; // will be mutated by conversations
        }

        const index: ConversationIndex<C> = new Map();
        // deno-lint-ignore no-explicit-any
        async function enter(id: string, ...args: any[]) {
            const builder = index.get(id);
            if (builder === undefined) {
                const known = Array.from(index.keys())
                    .map((id) => `'${id}'`)
                    .join(", ");
                throw new Error(
                    `The conversation '${id}' has not been registered! Known conversations are: ${known}`,
                );
            }
            await options.onEnter?.(id);
            const base: ContextBaseData = {
                update: ctx.update,
                api: ctx.api,
                me: ctx.me,
            };
            return await enterConversation(builder, base, ...args);
        }
        const exit = options.onExit !== undefined
            ? async (id: string) => {
                await options.onExit?.(id);
            }
            : undefined;

        function canSave() {
            return !(internalCompletenessMarker in ctx);
        }

        Object.defineProperty(ctx, internalMutableState, { get: getData });
        Object.defineProperty(ctx, internalIndex, { value: index });
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
// TODO: add wait timeouts
// export interface ConversationConfig {
//     id?: string;
//     maxMillisecondsToWait?: number;
// }

export function createConversation<C extends Context>(
    builder: ConversationBuilder<C>,
    id: string = builder.name,
): MiddlewareFn<ConversationContext<C>> {
    if (!id) {
        throw new Error("Cannot register a conversation without a name!");
    }
    return async (ctx, next) => {
        if (!(internalMutableState in ctx) || !(internalIndex in ctx)) {
            throw new Error(
                "Cannot register a conversation without installing the conversations plugin first!",
            );
        }

        const index = ctx[internalIndex] as ConversationIndex<C>;
        if (index.has(id)) {
            throw new Error(`Duplicate conversation identifier '${id}'!`);
        }
        index.set(id, builder);

        const mutableData = ctx[internalMutableState] as ConversationData;
        const base: ContextBaseData = {
            update: ctx.update,
            api: ctx.api,
            me: ctx.me,
        };
        const result = await runParallelConversations(
            builder,
            id,
            mutableData, // will be mutated on ctx
            base,
        );
        switch (result.status) {
            case "error":
                throw result.error;
            case "skipped":
                await next();
        }
    };
}

export async function runParallelConversations<C extends Context>(
    builder: ConversationBuilder<C>,
    id: string,
    data: ConversationData,
    base: ContextBaseData,
): Promise<ConversationResult> {
    if (!(id in data)) return { status: "skipped" };
    const states = data[id];
    const len = states.length;
    for (let i = 0; i < len; i++) {
        const result = await resumeConversation(builder, base, states[i]);
        switch (result.status) {
            case "skipped":
                continue;
            case "handled":
                states[i].replay = result.replay;
                states[i].interrupts = result.interrupts;
                return result;
            case "complete":
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

export async function enterConversation<C extends Context>(
    conversation: ConversationBuilder<C>,
    base: ContextBaseData,
    // deno-lint-ignore no-explicit-any
    ...args: any[]
): Promise<EnterResult> {
    const packedArgs = JSON.stringify(args);
    const [initialState, int] = ReplayEngine.open();
    const state: ConversationState = {
        args: packedArgs,
        replay: initialState,
        interrupts: [int],
    };
    const result = await resumeConversation(conversation, base, state);
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

export async function resumeConversation<C extends Context>(
    conversation: ConversationBuilder<C>,
    { update, api, me }: ContextBaseData,
    state: ConversationState,
): Promise<ConversationResult> {
    const args = JSON.parse(state.args);
    const engine = new ReplayEngine(async (controls) => {
        const hydrate = hydrateContext<C>(controls, api, me);
        const convo = new Conversation(controls, hydrate);
        const ctx = await convo.wait();
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
                return { status: "complete" };
            case "thrown":
                // tell caller that an error was thrown, it should leave the
                // conversation and rethrow the error
                return { status: "error", error: result.error };
            case "interrupted":
                if (result.message === "skip") {
                    // current interrupt was skipped, replay again with the next
                    ReplayEngine.reset(replayState, checkpoint);
                    continue;
                } else if (result.message === "halt") {
                    // tell caller that we are done, all good
                    return { status: "complete" };
                } else {
                    // tell caller that we handled the update and updated the state
                    return {
                        status: "handled",
                        replay: result.state,
                        interrupts: result.interrupts,
                    };
                }
        }
    }
    // tell caller that we want to skip the update and did not modify the state
    return { status: "skipped" };
}

function hydrateContext<C extends Context>(
    controls: ReplayControls,
    protoApi: Api,
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
                        throw new Error("unknown error thrown", { // cannot happen
                            cause: e,
                        });
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
                    new Error(ret.err.error),
                );
            }
        });
        const ctx = new Context(update, api, me) as C;
        Object.defineProperty(ctx, internalRecursionDetection, { value: true });
        return ctx;
    };
}
