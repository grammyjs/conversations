import { resolver } from "../src/resolve.ts";
import { create, cursor, inspect, mutate } from "../src/state.ts";
import {
    assertEquals,
    assertInstanceOf,
    assertRejects,
    assertThrows,
    describe,
    it,
} from "./deps.test.ts";

describe("create", () => {
    it("creates replay state", () => {
        const state = create();
        assertInstanceOf(state, Object);
    });
});

describe("mutate and inspect", () => {
    it("can mutate state", () => {
        const state = create();
        const mut = mutate(state);
        const op0 = mut.op("zero");
        const op1 = mut.op("one");
        mut.done(op1, "abc");
        mut.done(op0, "def");

        const get = inspect(state);
        assertEquals(get.opCount(), 2);
        assertEquals(get.payload(op0), "zero");
        assertEquals(get.payload(op1), "one");
        assertEquals(get.doneCount(), 2);
    });
    it("validate inspect calls", () => {
        const state = create();
        const get = inspect(state);
        assertThrows(() => get.payload(-1));
        assertThrows(() => get.payload(3));
        const mut = mutate(state);
        const op = mut.op("begin");
        assertEquals(get.payload(op), "begin");
        assertThrows(() => get.payload(-1));
        assertThrows(() => get.payload(3));
    });
    it("validate done calls", () => {
        const state = create();
        const mut = mutate(state);
        assertThrows(() => mut.done(-1, "result"));
        assertThrows(() => mut.done(0, "result"));
        assertThrows(() => mut.done(3, "result"));
        const op0 = mut.op();
        assertThrows(() => mut.done(-1, "result"));
        assertThrows(() => mut.done(3, "result"));
        mut.done(op0, "result");
    });
    it("can undo mutations based on checkpoints", () => {
        const state = create();
        const get = inspect(state);
        const mut = mutate(state);

        const op0 = mut.op("zero");
        const checkpoint = get.checkpoint();
        const op1 = mut.op("one");
        const op2 = mut.op("two");
        mut.done(op1, "def");
        mut.done(op2, "ghi");
        mut.reset(checkpoint);
        const op3 = mut.op("three");
        mut.done(op0, "abc");
        mut.done(op3, "jkl");

        assertEquals(get.opCount(), 2);
        assertEquals(get.payload(op0), "zero");
        assertEquals(get.payload(op3), "three");
        assertEquals(get.doneCount(), 2);
    });
});

describe("cursor", () => {
    it("can build up state", async () => {
        const state = create();
        const cur = cursor(state);
        const op0 = cur.op("zero");
        const op1 = cur.op("one");
        const res1 = await cur.done(
            op1,
            async () => await Promise.resolve("abc"),
        );
        const res0 = await cur.done(op0, () => "def");

        assertEquals(res0, "def");
        assertEquals(res1, "abc");
        const get = inspect(state);
        assertEquals(get.opCount(), 2);
        assertEquals(get.payload(op0), "zero");
        assertEquals(get.payload(op1), "one");
        assertEquals(get.doneCount(), 2);
    });
    it("validates done calls", async () => {
        const state = create();
        const cur = cursor(state);
        await assertRejects(() => cur.done(-1, () => "result"));
        await assertRejects(() => cur.done(0, () => "result"));
        await assertRejects(() => cur.done(3, () => "result"));
        const op0 = cur.op();
        await assertRejects(() => cur.done(-1, () => "result"));
        await assertRejects(() => cur.done(3, () => "result"));
        assertEquals(await cur.done(op0, () => "result"), "result");
    });
    it("can start with existing state", async () => {
        const state = create();

        { // setup
            const m = mutate(state);
            const op0 = m.op("zero");
            const op1 = m.op("one");
            m.done(op1, "abc");
            m.done(op0, "def");
        }

        const cur = cursor(state);
        const op0 = cur.op("zero");
        const op1 = cur.op("one");
        const res1 = await cur.done(op1, nevErr);
        const res0 = await cur.done(op0, nevErr);

        assertEquals(res0, "def");
        assertEquals(res1, "abc");
        const get = inspect(state);
        assertEquals(get.opCount(), 2);
        assertEquals(get.payload(op0), "zero");
        assertEquals(get.payload(op1), "one");
        assertEquals(get.doneCount(), 2);
    });
    it("can start with its own old state", async () => {
        const state = create();

        { // setup
            const c = cursor(state);
            const op0 = c.op("zero");
            const op1 = c.op("one");
            await c.done(op1, () => "abc");
            await c.done(op0, () => "def");
        }

        const cur = cursor(state);
        const op0 = cur.op("zero");
        const op1 = cur.op("one");
        const res1 = await cur.done(op1, nevErr);
        const res0 = await cur.done(op0, nevErr);

        assertEquals(res0, "def");
        assertEquals(res1, "abc");
        const get = inspect(state);
        assertEquals(get.opCount(), 2);
        assertEquals(get.payload(op0), "zero");
        assertEquals(get.payload(op1), "one");
        assertEquals(get.doneCount(), 2);
    });
    it("works with too few resolved ops", () => {
        const state = create();

        { // setup
            const c = cursor(state);
            c.op("zero");
            c.op("one");
        }

        const cur = cursor(state);
        const op0 = cur.op("zero");
        const op1 = cur.op("one");

        const get = inspect(state);
        assertEquals(get.opCount(), 2);
        assertEquals(get.payload(op0), "zero");
        assertEquals(get.payload(op1), "one");
        assertEquals(get.doneCount(), 0);
    });
    it("can detect bad replays based on the payload", async () => {
        const state = create();

        { // setup
            const c = cursor(state);
            const op0 = c.op("zero");
            const op1 = c.op("one");
            await c.done(op1, () => "abc");
            await c.done(op0, () => "def");
        }

        const cur = cursor(state);
        cur.op("zero");
        assertThrows(() => cur.op("nope"));
    });
    it("completes ops in order", async () => {
        const state = create();

        { // setup
            const c = cursor(state);
            const op0 = c.op("zero");
            const op1 = c.op("one");
            const op2 = c.op("two");
            // order: 2, 0, 1
            await Promise.all([
                c.done(op2, () => "ghi"),
                c.done(op0, () => "abc"),
                c.done(op1, () => "def"),
            ]);
        }

        const cur = cursor(state);
        const op0 = cur.op("zero");
        const op1 = cur.op("one");
        const op2 = cur.op("two");
        const order: number[] = [];
        const res = await Promise.all([
            // resolve in wrong order: 0, 1, 2
            cur.done(op0, nevErr).then((r) => {
                order.push(0);
                return r;
            }),
            cur.done(op1, nevErr).then((r) => {
                order.push(1);
                return r;
            }),
            cur.done(op2, nevErr).then((r) => {
                order.push(2);
                return r;
            }),
        ]);
        assertEquals(res, ["abc", "def", "ghi"]);
        assertEquals(order, [2, 0, 1]); // order was corrected
    });
    it("supports implicit op identifier handling", async () => {
        const state = create();
        const cur = cursor(state);
        let op = -1;
        const res = await cur.perform((o) => {
            op = o;
            return "res";
        }, "payload");
        const get = inspect(state);
        assertEquals(res, "res");
        assertEquals(get.opCount(), 1);
        assertEquals(get.doneCount(), 1);
        assertEquals(get.payload(op), "payload");
    });
    it("can perform chaotic ops from convenience functions", async () => {
        const state = create();

        const rsr = Array(10).fill(0).map(() => ({
            r: resolver(),
            i: Math.random(),
        }));

        const c = cursor(state);
        const ps0 = rsr
            .map(({ r, i }) => c.perform(() => r.promise, i.toString()));
        rsr.toSorted((l, r) => l.i - r.i)
            .forEach(({ r, i }) => r.resolve(i));
        const res0 = await Promise.all(ps0);
        assertEquals(res0, rsr.map(({ i }) => i));

        const cur = cursor(state);
        const order: unknown[] = [];
        const res1 = await Promise.all(
            rsr.map(({ i }, pos) =>
                cur.perform(nevErr, i.toString()).then((r) => {
                    order.push(pos);
                    return r;
                })
            ),
        );
        assertEquals(res1, rsr.map(({ i }) => i));
        assertEquals(
            order,
            rsr.map((e, pos) => ({ e, pos }))
                .toSorted((l, r) => l.e.i - r.e.i)
                .map(({ pos }) => pos),
        );

        const get = inspect(state);
        assertEquals(get.opCount(), 10);
        assertEquals(get.doneCount(), 10);
    });
    it("supports ops that never resolve", async () => {
        const state = create();
        const cur = cursor(state);
        const r = resolver();
        await Promise.race([
            r,
            cur.perform(async () => {
                r.resolve();
                await new Promise(() => {
                    // never resolves
                });
            }, "payload"),
            cur.perform(() => 42),
        ]);
        const get = inspect(state);
        assertEquals(get.opCount(), 2);
        assertEquals(get.doneCount(), 1);
    });
});

function nevErr() {
    throw new Error("never");
}
