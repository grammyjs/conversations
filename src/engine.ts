import { resolver } from "./resolve.ts";
import { create, cursor, mutate, type ReplayState } from "./state.ts";

export interface ReplayControls {
    interrupt(key?: string): Promise<unknown>;
    action(
        fn: () => unknown | Promise<unknown>,
        key?: string,
    ): Promise<unknown>;
}
export type Builder = (controls: ReplayControls) => void | Promise<void>;

export type ReplayResult = Returned | Thrown | Interrupted;
export interface Returned {
    type: "returned";
    returnValue: unknown;
}
export interface Thrown {
    type: "thrown";
    error: unknown;
}
export interface Interrupted {
    type: "interrupted";
    state: ReplayState;
    interrupted: number[];
}

export class ReplayEngine {
    constructor(private readonly builder: Builder) {}

    async play() {
        const state = create();
        return await this.replay({ state });
    }
    async replay({ state }: { state: ReplayState }) {
        return await replayFunc(this.builder, state);
    }

    static supply(result: Interrupted, value: unknown) {
        const mut = mutate(result.state);
        result.interrupted.forEach((op) => mut.done(op, value));
    }
}

async function replayFunc(
    builder: Builder,
    state: ReplayState,
): Promise<ReplayResult> {
    // Define replay controls
    const cur = cursor(state);
    const boundary = resolver();
    const interruptOps: Set<number> = new Set();
    const actionOps: Set<number> = new Set();
    async function interrupt(key?: string) {
        return await cur.perform(async (op) => {
            interruptOps.add(op);
            await Promise.resolve(); // TODO: investigate removal
            if (actionOps.size === 0) {
                boundary.resolve();
            }
            await boom();
        }, key);
    }
    async function action(
        fn: () => unknown | Promise<unknown>,
        key?: string,
    ) {
        return await cur.perform(async (op) => {
            actionOps.add(op);
            const res = await fn();
            actionOps.delete(op);
            if (actionOps.size === 0 && interruptOps.size > 0) {
                boundary.resolve();
            }
            return res;
        }, key);
    }
    const controls: ReplayControls = { interrupt, action };

    // Perform replay
    let returned = false;
    let returnValue: unknown = undefined;
    async function run() {
        returnValue = await builder(controls);
        returned = true;
    }
    try {
        await Promise.race([boundary.promise, run()]);
        if (boundary.isResolved()) {
            return {
                type: "interrupted",
                state,
                interrupted: Array.from(interruptOps),
            };
        } else if (returned) return { type: "returned", returnValue };
        else throw new Error("Neither returned nor interrupted!"); // should never happen
    } catch (error) {
        return { type: "thrown", error };
    } finally {
        // TODO: rely on `using` once it is stable
        cur.close();
    }
}

function boom() {
    return new Promise<never>(() => {});
}
