import { resolver } from "./resolve.ts";

const LISTENERS = Symbol.for("grammy.conversations.replay.listener");
export interface ReplayState {
    [LISTENERS]?: Array<() => void>;
    send: SendOp[];
    receive: ReceiveOp[];
}
interface SendOp {
    payload?: string;
}
interface ReceiveOp {
    send: number;
    returnValue: unknown;
}

export interface ReplayEvent {
    op: number;
    result: unknown;
}
function on(state: ReplayState, fn: () => void) {
    (state[LISTENERS] ??= []).push(fn);
}
function off(state: ReplayState, fn: () => void) {
    state[LISTENERS] = state[LISTENERS]?.filter((f) => f !== fn);
}
function notify(state: ReplayState) {
    state[LISTENERS]?.forEach((fn) => fn());
}

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
        if (op > state.send.length) throw new Error(`No op ${op} in state`);
        return state.send[op].payload;
    }
    return { opCount, doneCount, payload };
}

export function mutate(state: ReplayState) {
    function op(payload?: string) {
        const index = state.send.length;
        state.send.push({ payload });
        notify(state);
        return index;
    }
    function done(op: number, result: unknown) {
        if (op < 0) throw new Error(`Op ${op} is invalid`);
        if (op >= state.send.length) throw new Error(`No op ${op} in state`);
        state.receive.push({ send: op, returnValue: result });
        notify(state);
    }
    return { op, done };
}

export function cursor(state: ReplayState) {
    let changes = resolver();
    function listener() {
        changes.resolve();
        changes = resolver();
    }
    on(state, listener);
    function close() {
        off(state, listener);
    }

    let send = 0; // 0 <= send <= state.send.length
    let receive = 0; // 0 <= receive <= state.receive.length

    function op(payload?: string) {
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
        notify(state);
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
            }
            data = state.receive[receive].returnValue;
        } else {
            data = await result();
            state.receive.push({ send: op, returnValue: data });
        }
        receive++;
        notify(state);
        return data;
    }

    async function perform(
        action: (op: number) => unknown | Promise<unknown>,
        payload?: string,
    ) {
        const index = op(payload);
        return await done(index, () => action(index));
    }

    return { perform, op, done, close, [Symbol.dispose]: close };
}
