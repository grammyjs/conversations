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
    execution: ReplayState;
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
    const initialState = ReplayEngine.init();
    // TODO: we cannot supply a received update before we are waiting for it,
    // and we cannot wait for an update without receiving it first. How should
    // this be solved?
    ReplayEngine.supply(initialState, 0, update);
    const state: ConversationState = {
        args: packedArgs,
        execution: initialState,
    };
    return await resumeConversation(conversation, update, api, me, state);
}
export async function resumeConversation<
    C extends Context,
    // deno-lint-ignore no-explicit-any
    A extends any[] = [],
>(
    conversation: ConversationBuilder<C, A>,
    update: Update,
    api: Api,
    me: UserFromGetMe,
    state: ConversationState,
) {
    const args = JSON.parse(state.args);
    const execution = state.execution;
    const engine = new ReplayEngine(async (controls) => {
        const hydrate = hydrateContext<C>(controls, api, me);
        const convo = new Conversation(controls, hydrate);
        const ctx = await convo.wait();
        await conversation(convo, ctx, ...args);
    });

    // TODO: supply new update
    await engine.replay(execution);
    // TODO: remaining steps
}
