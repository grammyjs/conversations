import { resolver } from "./resolve.ts";
import { create, cursor, mutate, type ReplayState } from "./state.ts";

export interface ReplayControls {
    interrupt(key?: string): Promise<unknown>;
    cancel(key?: string): Promise<never>;
    action<R = unknown>(
        fn: () => R | Promise<R>,
        key?: string,
    ): Promise<R>;
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
    message?: string;
    state: ReplayState;
    interrupts: number[];
}

export class ReplayEngine {
    constructor(private readonly builder: Builder) {}

    async play() {
        const state = create();
        return await this.replay(state);
    }
    async replay(state: ReplayState) {
        return await replayState(this.builder, state);
    }

    static supply(state: ReplayState, interrupt: number, value: unknown) {
        const mut = mutate(state);
        mut.done(interrupt, value);
    }
}

async function replayState(
    builder: Builder,
    state: ReplayState,
): Promise<ReplayResult> {
    const cur = cursor(state);

    // Set up interrupt and action tracking
    let interrupted = false;
    const interrupts: number[] = [];
    let message: string | undefined = undefined;
    const boundary = resolver();
    const actions = new Set<number>();
    function updateBoundary() {
        if (interrupted && actions.size === 0) {
            boundary.resolve();
        }
    }

    // Set up event loop tracking to prevent
    // premature returns with floating promises
    let promises = 0; // counts the number of promises on the event loop
    let dirty = resolver(); // resolves as soon as the event loop is clear
    function begin() {
        promises++;
    }
    function end() {
        promises--;
        if (promises === 0) {
            dirty.resolve();
            dirty = resolver();
        }
    }

    // Define replay controls
    async function interrupt(key?: string) {
        begin();
        const res = await cur.perform(async (op) => {
            interrupted = true;
            message = key;
            interrupts.push(op);
            updateBoundary();
            await boom();
        }, key);
        end();
        return res;
    }
    async function cancel(key?: string) {
        interrupted = true;
        message = key;
        updateBoundary();
        return await boom();
    }
    async function action<R>(fn: () => R | Promise<R>, key?: string) {
        begin();
        const res = await cur.perform(async (op) => {
            actions.add(op);
            const ret = await fn();
            actions.delete(op);
            updateBoundary();
            return ret;
        }, key) as R;
        end();
        return res;
    }
    const controls: ReplayControls = { interrupt, cancel, action };

    // Perform replay
    let returned = false;
    let returnValue: unknown = undefined;
    async function run() {
        returnValue = await builder(controls);
        while (promises > 0) {
            await dirty.promise;
            await 0; // move to end of event loop by spinning it
        }
        returned = true;
    }
    try {
        await Promise.race([boundary.promise, run()]);
        if (boundary.isResolved()) {
            return { type: "interrupted", message, state, interrupts };
        } else if (returned) {
            return { type: "returned", returnValue };
        } else {
            throw new Error("Neither returned nor interrupted!"); // should never happen
        }
    } catch (error) {
        return { type: "thrown", error };
    }
}

function boom() {
    return new Promise<never>(() => {});
}
