import { resolver } from "./resolve.ts";

/**
 * A replay state.
 *
 * A replay state consists of two logs of operations.
 *
 * 1. A send log which records send operations in the shape of {@link SendOp}
 * 2. A receive log which records receive operations in the shape of
 *    {@link ReceiveOp}
 *
 * Note that each receive op links to a specific send op. A valid replay state
 * should only contain receive ops that point to send ops contained in the same
 * replay state.
 *
 * A replay state can be created using {@link create}.
 */
export interface ReplayState {
    /** The send log of the replay state */
    send: SendOp[];
    /** The receive log of the replay state */
    receive: ReceiveOp[];
}
/** A send operation */
export interface SendOp {
    /** Any string payload for the send operation */
    payload: string;
}
/** A receive operation */
export interface ReceiveOp {
    /** The identifier (index in a send log) of a send op */
    send: number;
    /** The received value */
    returnValue: unknown;
}

/** A checkpoint in a replay log */
export type Checkpoint = [number, number];

/**
 * Creates and returns an empty {@link ReplayState} object.
 *
 * The returned replay state can be inspected via {@link inspect}, mutated via
 * {@link mutate}, and replayed via {@link cursor}.
 */
export function create(): ReplayState {
    return { send: [], receive: [] };
}

/**
 * Holds a number of tools that can be used to inspect a replay state.
 *
 * This object is typically created via {@link inspect}.
 */
export interface InspectTools {
    /** Gets the number of send ops */
    opCount(): number;
    /** Gets the number of receive ops */
    doneCount(): number;
    /** Looks up the payload of a send op */
    payload(op: number): string;
    /** Creates a checkpoint for the current replay state */
    checkpoint(): Checkpoint;
}

/**
 * Provides inspections tools for a given replay state.
 *
 * @param state The replay state to inspect
 */
export function inspect(state: ReplayState): InspectTools {
    function opCount() {
        return state.send.length;
    }
    function doneCount() {
        return state.receive.length;
    }
    function payload(op: number) {
        if (op < 0) throw new Error(`Op ${op} is invalid`);
        if (op >= state.send.length) throw new Error(`No op ${op} in state`);
        return state.send[op].payload;
    }
    function checkpoint(): Checkpoint {
        return [opCount(), doneCount()];
    }
    return { opCount, doneCount, payload, checkpoint };
}

/**
 * Holds a number of tools that can be used to mutate a replay state.
 *
 * This object is typically created via {@link mutate}.
 */
export interface MutateTools {
    /**
     * Begins an op by recording a send op. Returns the send op identifier.
     *
     * @param payload A payload to send
     */
    op(payload: string): number;
    /**
     * Completes an op by recording a receive op for a given send op.
     *
     * @param op The identifier of the send op to complete.
     * @param result The result of the op
     */
    done(op: number, result: unknown): void;
    /**
     * Resets the replay state to a given checkpoint that was obtained
     * previously through {@link inspect}ion of the replay state.
     *
     * @param checkpoint The known checkpoint
     */
    reset([op, done]: Checkpoint): void;
}

/**
 * Provides tools to mutate a given replay state.
 *
 * @param state The replay state to mutate
 */
export function mutate(state: ReplayState): MutateTools {
    function op(payload: string) {
        const index = state.send.length;
        state.send.push({ payload });
        return index;
    }
    function done(op: number, result: unknown) {
        if (op < 0) throw new Error(`Op ${op} is invalid`);
        if (op >= state.send.length) throw new Error(`No op ${op} in state`);
        state.receive.push({ send: op, returnValue: result });
    }
    function reset([op, done]: Checkpoint) {
        if (op < 0 || done < 0) throw new Error("Invalid checkpoint");
        state.send.splice(op);
        state.receive.splice(done);
    }

    return { op, done, reset };
}

/**
 * Can be used to iterate a given replay state.
 *
 * This object is typically created via {@link cursor}.
 *
 * Note that this object holds state outside of the replay state itself, namely
 * the current position of the cursor.
 */
export interface ReplayCursor {
    /**
     * Performs an action at the current position of the replay cursor, records
     * its result in the replay state, and advances the cursor.
     *
     * Note that if the cursor has not reached the end of the replay state yet,
     * the action will be replayed from the log.
     *
     * @param action The action to perform, receiving a send op identifer
     * @param payload The payload to assign to this action
     */
    perform(
        action: (op: number) => unknown | Promise<unknown>,
        payload: string,
    ): Promise<unknown>;
    /**
     * Begins a new op at the current position of the replay cursor, and
     * advances the cursor.
     *
     * Note that if the cursor has not reached the end of the replay state yet,
     * the op will be taken from the log.
     *
     * @param payload The payload to assign to this op
     */
    op(payload: string): number;
    /**
     * Completes a given op with the result obtained from a callback function,
     * and advances the cursor.
     *
     * Note that if the cursor has not reached the end of the replay state yet,
     * the callback function will not be invoked. Instead, the result will be
     * replayed from the log.
     *
     * @param op The op to complete
     * @param result The result to record
     */
    done(
        op: number,
        result: () => unknown | Promise<unknown>,
    ): Promise<unknown>;
    /** Creates a checkpoint at the current state of the cursor */
    checkpoint(): Checkpoint;
}

/**
 * Provides tools to iterate a given replay state.
 *
 * @param state The replay state to iterate
 */
export function cursor(state: ReplayState): ReplayCursor {
    let changes = resolver();
    function notify() {
        changes.resolve();
        changes = resolver();
    }

    let send = 0; // 0 <= send <= state.send.length
    let receive = 0; // 0 <= receive <= state.receive.length

    function op(payload: string) {
        if (send < state.send.length) {
            // replay existing data (do nothing)
            const expected = state.send[send].payload;
            if (expected !== payload) {
                throw new Error(`Bad replay, expected op '${expected}'`);
            }
        } else { // send === state.send.length
            // log new data
            state.send.push({ payload });
        }
        const index = send++;
        notify();
        return index;
    }
    async function done(op: number, result: () => unknown | Promise<unknown>) {
        if (op < 0) throw new Error(`Op ${op} is invalid`);
        if (op >= state.send.length) throw new Error(`No op ${op} in state`);
        let data: unknown;
        if (receive < state.receive.length) {
            // replay existing data (do nothing)
            while (state.receive[receive].send !== op) {
                // make sure we resolve only when it is our turn
                await changes.promise;
                if (receive === state.receive.length) {
                    // It will never be our turn, because the replay completed
                    // and we are still here. We will have to call `result`.
                    return await done(op, result);
                }
            } // state.receive[receive].send === op
            data = state.receive[receive].returnValue;
        } else { // receive === state.receive.length
            data = await result();
            state.receive.push({ send: op, returnValue: data });
        }
        receive++;
        notify();
        return data;
    }
    async function perform(
        action: (op: number) => unknown | Promise<unknown>,
        payload: string,
    ) {
        const index = op(payload);
        return await done(index, () => action(index));
    }
    function checkpoint(): Checkpoint {
        return [send, receive];
    }

    return { perform, op, done, checkpoint };
}
