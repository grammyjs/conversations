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

type MaybePromise<T> = T | Promise<T>;
export interface ConversationOptions<C extends Context> {
    read(ctx: C): MaybePromise<ConversationData | undefined>;
    write(ctx: C, state: ConversationData): void | Promise<void>;
    delete(ctx: C): void | Promise<void>;
    onEnter?(id: string): unknown | Promise<unknown>;
    onExit?(id: string): unknown | Promise<unknown>;
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
    // deno-lint-ignore no-explicit-any
    enter: (name: string, ...args: any[]) => Promise<EnterResult>,
    exit: (name: string) => Promise<void>,
    canSave: () => boolean,
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
            for (let i = 0; i < len; i++) {
                await exit(name);
            }
        },
        async exit(name) {
            const data = getData();
            if (data[name] === undefined) return;
            const len = data[name].length;
            delete data[name];
            for (let i = 0; i < len; i++) {
                await exit(name);
            }
        },
        async exitOne(name, index) {
            const data = getData();
            if (
                data[name] === undefined ||
                index < 0 || data[name].length <= index
            ) return;
            data[name].splice(index, 1);
            await exit(name);
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
    return async (ctx, next) => {
        if (internalRecursionDetection in ctx) {
            throw new Error(
                "Cannot install the conversations plugin on context objects created by the conversations plugin!",
            );
        }
        if (internalMutableState in ctx) {
            throw new Error("Cannot install conversations plugin twice!");
        }

        let read = false;
        const res = await options.read(ctx);
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
            return await enterConversation(
                builder,
                ctx.update,
                ctx.api,
                ctx.me,
                ...args,
            );
        }
        async function exit(id: string) {
            await options.onExit?.(id);
        }

        function canSave() {
            return !(internalCompletenessMarker in ctx);
        }

        Object.defineProperty(ctx, internalMutableState, { get: getData });
        Object.defineProperty(ctx, internalIndex, { value: index });
        Object.defineProperty(ctx, "conversation", {
            value: controls(getData, enter, exit, canSave),
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
                await options.write(ctx, state);
            } else if (!empty) {
                await options.delete(ctx);
            }
        }
    };
}

interface ConversationState {
    args: string;
    replay: ReplayState;
    interrupts: number[];
}
type ConversationResult =
    | ConversationComplete
    | ConversationError
    | ConversationHandled
    | ConversationSkipped;
interface ConversationComplete {
    status: "complete";
}
interface ConversationError {
    status: "error";
    error: unknown;
}
interface ConversationHandled {
    status: "handled";
    replay: ReplayState;
    interrupts: number[];
}
interface ConversationSkipped {
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
        const result = await runParallelConversations(
            builder,
            id,
            mutableData, // will be mutated on ctx
            ctx.update,
            ctx.api,
            ctx.me,
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
    update: Update,
    api: Api,
    me: UserFromGetMe,
): Promise<ConversationResult> {
    if (!(id in data)) return { status: "skipped" };
    const states = data[id];
    const len = states.length;
    for (let i = 0; i < len; i++) {
        const result = await resumeConversation(
            builder,
            update,
            api,
            me,
            states[i],
        );
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
    update: Update,
    api: Api,
    me: UserFromGetMe,
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
    const result = await resumeConversation(
        conversation,
        update,
        api,
        me,
        state,
    );
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
    update: Update,
    api: Api,
    me: UserFromGetMe,
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
    for (const int of state.interrupts) {
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
