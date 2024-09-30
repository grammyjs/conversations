import { resolver } from "./resolve.ts";

export interface ReplayState {
    send: SendOp[];
    receive: ReceiveOp[];
}
interface SendOp {
    payload: string;
}
interface ReceiveOp {
    send: number;
    returnValue: unknown;
}

export type Checkpoint = [number, number];

export function create(): ReplayState {
    return { send: [], receive: [] };
}

export function inspect(state: ReplayState) {
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

export function mutate(state: ReplayState) {
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

export function cursor(state: ReplayState) {
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
                    // It will never be our turn, because
                    // the replay completed and we are still here.
                    return;
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
