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

/**
 * Controls for a replay. This is the object that a {@link ReplayEngine} passes
 * to the replay function when executing it.
 */
export interface ReplayControls {
    /**
     * Interrupts the current replay and record this event in the replay logs.
     * The replay will finish with an {@link Interrupted} result.
     *
     * Use {@link ReplayEngine.supply} to supply the result of this interrupt to
     * the underlying replay state. When replaying the modified state, this call
     * to `interrupt` will resolve with the supplied value.
     *
     * You also need to pass a key that identifies this type of interrupt. It is
     * stored in the replay state and will be collated with the key that is
     * passed to `interrupt` during the repeated call. If the two keys do not
     * match, this means that a bad replay was detected and an error will be
     * thrown. You should discard the replay state and restart the replay from
     * scratch.
     *
     * @param key A key to collate interrupts across replays
     */
    interrupt(key: string): Promise<unknown>;
    /**
     * Cancels the replay. This tells the replay engine that a supplied
     * interrupt value should be rejected. The replay will finish with a
     * {@link Canceled} result.
     *
     * A message object can be passed to `cancel`. This can be used to
     * communicate to the caller why the interrupt value was rejected.
     *
     * @param message A message specifiying the reason for the cancelation
     */
    cancel(message?: unknown): Promise<never>;
    /**
     * Performs an action.
     *
     * Actions are a way to signal to the replay engine that a particular piece
     * of code should not be run repeatedly. The result of the action will be
     * stored in the underlying replay log. During a subsequent replay, the
     * action will not be repeated. Instead, the return is taken from the replay
     * log.
     *
     * You also need to pass a key that identifies this type of action. It is
     * stored in the replay state and will be collated with the key that is
     * passed to `action` during the repeated call. If the two keys do not
     * match, this means that a bad replay was detected and an error will be
     * thrown. You should discard the replay state and restart the replay from
     * scratch.
     *
     * @param fn The action to perform
     * @param key A key to collate actions across replays
     */
    action<R = unknown>(
        fn: () => R | Promise<R>,
        key: string,
    ): Promise<R>;
    /**
     * Creates a checkpoint at the current position of the replay. This can be
     * passed to {@link ReplayEngine.reset} in order to restart a replay from an
     * arbitrary position.
     */
    checkpoint(): Checkpoint;
}
/** A function to be replayed by a {@link ReplayEngine} */
export type Builder = (controls: ReplayControls) => void | Promise<void>;
/** The result of a replay performed by a {@link ReplayEngine} */
export type ReplayResult = Returned | Thrown | Interrupted | Canceled;
/**
 * This result is returned by a {@link ReplayEngine} when the builder function
 * completes normally by returning.
 */
export interface Returned {
    /**
     * Type of the replay result, indicates that the replay has completed
     * normally because the builder function has returned.
     */
    type: "returned";
    /** The return value of the builder function */
    returnValue: unknown;
}
/**
 * This result is returned by a {@link ReplayEngine} when the builder function
 * throws an error.
 */
export interface Thrown {
    /**
     * Type of the replay result, indicates that the replay has completed
     * because the builder function has thrown an error.
     */
    type: "thrown";
    /** The error thrown by the builder function */
    error: unknown;
}
/**
 * This result is returned by a {@link ReplayEngine} when the builder function
 * interrupts itself by calling {@link ReplayControls.interrupt}.
 */
export interface Interrupted {
    /**
     * Type of the replay result, indicates that the replay has completed
     * because the builder function has interrupted itself.
     */
    type: "interrupted";
    /** The replay state left behind by the replay engine */
    state: ReplayState;
    /** The list of concurrent interrupts that were performed */
    interrupts: number[];
}
/**
 * This result is returned by a {@link ReplayEngine} when the builder function
 * cancels itself by calling {@link ReplayControls.cancel}.
 */
export interface Canceled {
    /**
     * Type of the replay result, indicates that the replay has completed
     * because the builder function has canceled itself.
     */
    type: "canceled";
    /** The message passed to the last concurrent cancel call */
    message?: unknown;
}

/**
 * A replay engine takes control of the event loop of the JavaScript runtime and
 * lets you execute a JavaScript function in abnormal ways. The function
 * execution can be halted, resumed, aborted, and reversed. This lets you run a
 * function partially and persist the state of execution in a database. Later,
 * function execution can be resumed from where it was left off.
 *
 * Replay engines are the fundamental building block of the conversations
 * plugin. In a sense, everything else is just a number of wrapper layers to
 * make working with replay engines more convenient, and to integrate the power
 * of replay engines into your bot's middleware system.
 *
 * Using a standalone replay engine is straightforward.
 *
 * 1. Create an instance of this class and pass a normal JavaScript function to
 *    the constructor. The function receives a {@link ReplayControls} object as
 *    its only parameter.
 * 2. Call {@link ReplayEngine.play} to begin a new execution. It returns a
 *    {@link ReplayResult} object.
 * 3. Use the {@link ReplayState} you obtained inside the result object and
 *    resume execution by calling {@link ReplayEngine.replay}.
 *
 * The `ReplayEngine` class furthermore provides you with static helper methods
 * to supply values to interrupts, and to reset the replay state to a previously
 * created checkpoint.
 */
export class ReplayEngine {
    /**
     * Constructs a new replay engine from a builder function. The function
     * receives a single parameter that can be used to control the replay.
     *
     * @param builder A builder function to be executed and replayed
     */
    constructor(private readonly builder: Builder) {}

    /**
     * Begins a new execution of the builder function. This starts based on
     * fresh state. The execution is independent from any previously created
     * executions.
     *
     * A {@link ReplayResult} object is returned to communicate the outcome of
     * the execution.
     */
    async play() {
        const state = create();
        return await this.replay(state);
    }
    /**
     * Resumes execution based on a previously created replay state. This is the
     * most important method of this class.
     *
     * A {@link ReplayResult} object is returned to communicate the outcome of
     * the execution.
     *
     * @param state A previously created replay state
     */
    async replay(state: ReplayState) {
        return await replayState(this.builder, state);
    }

    /**
     * Creates a new replay state with a single unresolved interrupt. This state
     * can be used as a starting point to replay arbitrary builder functions.
     *
     * You need to pass the collation key for the aforementioned first
     * interrupt. This must be the same value that the builder function will
     * pass to its first interrupt.
     *
     * @param key The builder functions first collation key
     */
    static open(key: string) {
        const state = create();
        const mut = mutate(state);
        const int = mut.op(key);
        return [state, int] as const;
    }
    /**
     * Mutates a given replay state by supplying a value for a given interrupt.
     * The next time the state is replayed, the targeted interrupt will return
     * this value.
     *
     * The interrupt value has to be one of the interrupts of a previously
     * received {@link Interrupted} result.
     *
     * In addition to mutating the replay state, a checkpoint is created and
     * returned. This checkpoint may be used to reset the replay state to its
     * previous value. This will undo this and all following mutations.
     *
     * @param state A replay state to mutate
     * @param interrupt An interrupt to resolve
     * @param value The value to supply
     */
    static supply(state: ReplayState, interrupt: number, value: unknown) {
        const get = inspect(state);
        const checkpoint = get.checkpoint();
        const mut = mutate(state);
        mut.done(interrupt, value);
        return checkpoint;
    }
    /**
     * Resets a given replay state to a previously received checkpoint by
     * mutating the replay state.
     *
     * @param state The state to mutate
     * @param checkpoint The checkpoint to which to return
     */
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

    // Collect data to return to caller
    let canceled = false;
    let message: unknown = undefined;
    let returned = false;
    let returnValue: unknown = undefined;

    // Define replay controls
    async function interrupt(key: string) {
        if (returned || (interrupted && interrupts.length === 0)) {
            // Already returned or canceled, so we must no longer perform an interrupt.
            await boom();
        }
        begin();
        const res = await cur.perform(async (op) => {
            interrupted = true;
            interrupts.push(op);
            updateBoundary();
            await boom();
        }, key);
        end();
        return res;
    }
    async function cancel(key?: unknown) {
        if (complete) {
            throw new Error(
                "Cannot perform a cancel operation after the conversation has completed, are you missing an `await`?",
            );
        }
        canceled = true;
        interrupted = true;
        message = key;
        updateBoundary();
        return await boom();
    }
    async function action<R>(fn: () => R | Promise<R>, key: string) {
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
    function checkpoint() {
        return cur.checkpoint();
    }
    const controls: ReplayControls = { interrupt, cancel, action, checkpoint };

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
            if (canceled) {
                return { type: "canceled", message };
            } else {
                return { type: "interrupted", state, interrupts };
            }
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
