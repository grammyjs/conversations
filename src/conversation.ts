import { type Context, type Update } from "./deps.deno.ts";
import { type ReplayControls } from "./engine.ts";

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
            // TODO: Make sure that no other ops are performed concurrently (or
            // from within the handler) because they will not be performed
            // during a replay so they will be missing from the logs then, which
            // clogs up the replay. This detection must be done here because
            // this is the only place where misuse can be detected properly. The
            // replay engine cannot discover that on its own because otherwise
            // it would not support concurrent ops at all, which is undesired.
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
    // TODO: add more methods
}
