import { type Context, type MiddlewareFn, type Update } from "./deps.deno.ts";
import { type ReplayControls } from "./engine.ts";

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
    maxMillisecondsToWait: number | undefined;
}

export interface WaitOptions {
    maxMilliseconds?: number;
}
export interface SkipOptions {
    drop?: boolean;
}
export interface HaltOptions {
    proceed?: boolean;
}

export class Conversation<C extends Context = Context> {
    /** true if external is currently running, false otherwise */
    private insideExternal = false;
    constructor(
        private controls: ReplayControls,
        private hydrate: (update: Update) => C,
        private escape: ApplyContext,
        private middleware: MiddlewareFn<C>,
        private options: ConversationHandleOptions,
    ) {}
    // TODO: add forms
    // TODO: add menus
    async wait(options: WaitOptions = {}): Promise<C> {
        if (this.insideExternal) {
            throw new Error(
                "Cannot wait for updates from inside `external`, or concurrently to it! \
First return your data from `external` and then resume update handling using `wait` calls.",
            );
        }

        const limit = "maxMilliseconds" in options
            ? options.maxMilliseconds
            : this.options.maxMillisecondsToWait;
        const before = limit !== undefined && await this.now();
        const update = await this.controls.interrupt() as Update;
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
        return nextCalled ? ctx : await this.wait();
    }
    async skip(options?: SkipOptions): Promise<never> {
        return await this.controls.cancel(options?.drop ? "drop" : "skip");
    }
    async halt(options?: HaltOptions): Promise<never> {
        await this.options.onHalt?.();
        return await this.controls.cancel(options?.proceed ? "kill" : "halt");
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
        const ret = await this.controls.action(action);
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
    // TODO: add more methods
}
