import {
    Api,
    Composer,
    Context,
    HttpError,
    type Middleware,
    type Update,
    type UserFromGetMe,
} from "./deps.deno.ts";
import { type ReplayControls, ReplayEngine } from "./engine.ts";
import { type ReplayState } from "./state.ts";

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
                    "Recovered error: " + ret.err.message,
                    new Error(ret.err.error),
                );
            }
        });
        const ctx = new Context(update, api, me) as C;
        return ctx;
    };
}

// deno-lint-ignore no-explicit-any
export interface ExternalOp<F extends (...args: any[]) => any, I = any> {
    task: F;
    args?: Parameters<F>;
    beforeStore?: (value: Awaited<ReturnType<F>>) => I | Promise<I>;
    afterLoad?: (value: I) => ReturnType<F> | Promise<ReturnType<F>>;
    beforeStoreError?: (value: unknown) => unknown | Promise<unknown>;
    afterLoadError?: (value: unknown) => unknown;
}

export class Conversation<C extends Context> {
    private readonly middleware = new Composer<C>();
    constructor(
        private controls: ReplayControls,
        private hydrate: (update: Update) => C,
    ) {}
    async wait(): Promise<C> {
        const update = await this.controls.interrupt() as Update;
        return this.hydrate(update);
    }
    async skip(): Promise<never> {
        return await this.controls.cancel("skip");
    }
    async halt(): Promise<never> {
        return await this.controls.cancel("halt");
    }
    // deno-lint-ignore no-explicit-any
    async external<F extends (...args: any[]) => any, I = any>(
        // deno-lint-ignore no-explicit-any
        op: (() => any) | ExternalOp<F, I>,
    ): Promise<Awaited<ReturnType<F>>> {
        const {
            task,
            afterLoad = (x: I) => x as ReturnType<F>,
            afterLoadError = (e: unknown) => e,
            args = [],
            beforeStore = (x: ReturnType<F>) => x as I,
            beforeStoreError = (e: unknown) => e,
        } = typeof op === "function" ? { task: op as F } : op;
        // Prepare values before storing them
        async function action() {
            try {
                const ret = await task(...args);
                return { ok: true, ret: await beforeStore(ret) } as const;
            } catch (e) {
                return { ok: false, err: await beforeStoreError(e) } as const;
            }
        }
        // Recover values after loading them
        const ret = await this.controls.action(action);
        if (ret.ok) {
            return await afterLoad(ret.ret);
        } else {
            throw await afterLoadError(ret.err);
        }
    }
    async run(..._middleware: Middleware<C>[]) {
        // TODO: implement
    }
    // TODO: add more methods
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

export async function enterConversation<C extends Context>(
    conversation: ConversationBuilder<C>,
    update: Update,
    api: Api,
    me: UserFromGetMe,
    // deno-lint-ignore no-explicit-any
    ...args: any[]
) {
    const packedArgs = JSON.stringify(args);
    const initialState = ReplayEngine.init(update);
    const state: ConversationState = {
        args: packedArgs,
        replay: initialState,
        interrupts: [],
    };
    return await resumeConversation(conversation, update, api, me, state);
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
