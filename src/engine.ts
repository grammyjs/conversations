import { resolver } from "./resolve.ts";
import {
    type Checkpoint,
    create,
    cursor,
    inspect,
    mutate,
    type ReplayState,
} from "./state.ts";
export { type Checkpoint, type ReplayState } from "./state.ts";

export interface ReplayControls {
    interrupt(key: string): Promise<unknown>;
    cancel(message?: unknown): Promise<never>;
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
    message?: unknown;
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

    static open() {
        const state = create();
        const mut = mutate(state);
        const int = mut.op();
        return [state, int] as const;
    }
    static supply(state: ReplayState, interrupt: number, value: unknown) {
        const get = inspect(state);
        const checkpoint = get.checkpoint();
        const mut = mutate(state);
        mut.done(interrupt, value);
        return checkpoint;
    }
    static reset(state: ReplayState, checkpoint: Checkpoint) {
        const mut = mutate(state);
        mut.reset(checkpoint);
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
    let message: unknown = undefined;
    let boundary = resolver();
    const actions = new Set<number>();
    function updateBoundary() {
        if (interrupted && actions.size === 0) {
            boundary.resolve();
        }
    }
    async function runBoundary() {
        while (!boundary.isResolved()) {
            await boundary.promise;
            // clear microtask queue and check if another action was started
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    // Set up event loop tracking to prevent
    // premature returns with floating promises
    let promises = 0; // counts the number of promises on the event loop
    let dirty = resolver(); // resolves as soon as the event loop is clear
    let returned = false;
    let returnValue: unknown = undefined;
    let complete = false; // locks the engine after the event loop has cleared
    function begin() {
        if (complete) {
            throw new Error(
                "Cannot begin another operation after the conversation has completed, are you missing an `await`?",
            );
        }
        promises++;
        if (boundary.isResolved()) {
            // new action was started after interrupt, reset boundary
            boundary = resolver();
        }
    }
    function end() {
        promises--;
        if (promises === 0) {
            dirty.resolve();
            dirty = resolver();
        }
    }

    // Define replay controls
    async function interrupt(key: string) {
        if (returned || (interrupted && interrupts.length === 0)) {
            // Already returned or canceled, so we must no longer perform an interrupt.
            await boom();
        }
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
    async function run() {
        returnValue = await builder(controls);
        returned = true;
        // wait for pending ops to complete
        while (promises > 0) {
            await dirty.promise;
            // clear microtask queue and check again
            await new Promise((r) => setTimeout(r, 0));
        }
    }
    try {
        const boundaryPromise = runBoundary();
        const runPromise = run();
        await Promise.race([boundaryPromise, runPromise]);
        if (returned) {
            return { type: "returned", returnValue };
        } else if (boundary.isResolved()) {
            return { type: "interrupted", message, state, interrupts };
        } else {
            throw new Error("Neither returned nor interrupted!"); // should never happen
        }
    } catch (error) {
        return { type: "thrown", error };
    } finally {
        complete = true;
    }
}

function boom() {
    return new Promise<never>(() => {});
}
