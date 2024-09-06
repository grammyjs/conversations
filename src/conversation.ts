import { type Context, type MiddlewareFn, type Update } from "./deps.deno.ts";
import { type ReplayControls } from "./engine.ts";

// deno-lint-ignore no-explicit-any
export interface ExternalOp<F extends (ctx: Context) => any, I = any> {
    task: F;
    beforeStore?: (value: Awaited<ReturnType<F>>) => I | Promise<I>;
    afterLoad?: (value: I) => ReturnType<F> | Promise<ReturnType<F>>;
    beforeStoreError?: (value: unknown) => unknown | Promise<unknown>;
    afterLoadError?: (value: unknown) => unknown | Promise<unknown>;
}
// deno-lint-ignore no-explicit-any
type ApplyContext = <F extends (ctx: Context) => any>(
    fn: F,
) => Promise<ReturnType<F>>;

export class Conversation<C extends Context = Context> {
    /** true if external is currently running, false otherwise */
    private insideExternal = false;
    constructor(
        private controls: ReplayControls,
        private escape: ApplyContext,
        private hydrate: (update: Update) => C,
        private middleware: MiddlewareFn<C>,
    ) {}
    // TODO: add forms
    async wait(): Promise<C> {
        if (this.insideExternal) {
            throw new Error(
                "Cannot wait for updates from inside `external`, or concurrently to it! \
First return your data from `external` and then resume update handling using `wait` calls.",
            );
        }
        const update = await this.controls.interrupt() as Update;
        const ctx = this.hydrate(update);
        let nextCalled = false;
        await this.middleware(ctx, () => {
            nextCalled = true;
            return Promise.resolve();
        });
        return nextCalled ? ctx : await this.wait();
    }
    async skip(): Promise<never> {
        return await this.controls.cancel("skip");
    }
    async halt(): Promise<never> {
        return await this.controls.cancel("halt");
    }
    // deno-lint-ignore no-explicit-any
    async external<F extends (ctx: Context) => any, I = any>(
        op: F | ExternalOp<F, I>,
    ): Promise<Awaited<ReturnType<F>>> {
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
            afterLoad = (x: I) => x as ReturnType<F>,
            afterLoadError = (e: unknown) => e,
            beforeStore = (x: ReturnType<F>) => x as I,
            beforeStoreError = (e: unknown) => e,
        } = typeof op === "function" ? { task: op as F } : op;
        // Prepare values before storing them
        const action = async () => {
            this.insideExternal = true;
            try {
                const ret = await this.escape(task);
                return { ok: true, ret: await beforeStore(ret) } as const;
            } catch (e) {
                return { ok: false, err: await beforeStoreError(e) } as const;
            } finally {
                this.insideExternal = false;
            }
        };
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
