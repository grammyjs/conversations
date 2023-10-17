import { type ReplayControls, ReplayEngine } from "../src/engine.ts";
import {
    assert,
    assertEquals,
    assertGreater,
    assertSpyCall,
    assertSpyCalls,
    describe,
    it,
    spy,
} from "./deps.test.ts";

describe("ReplayEngine", () => {
    it("should run the builder function", async () => {
        const builder = spy(() => {});
        const engine = new ReplayEngine(builder);
        const result = await engine.play();
        assertEquals(result.type, "returned");
        assertSpyCalls(builder, 1);
    });
    it("should replay until a return value", async () => {
        const builder = spy(async (c: ReplayControls) => {
            const res0 = await c.interrupt();
            assertEquals(res0, "zero");
            const res1 = await c.interrupt();
            assertEquals(res1, "one");
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "zero");
        result = await engine.replay(result.state);
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "one");
        result = await engine.replay(result.state);
        assert(result.type === "returned");
        assertSpyCalls(builder, 3);
    });
    it("should support actions", async () => {
        let i = 0;
        const action = spy(() => i++);
        const builder = spy(async (c: ReplayControls) => {
            const r0 = await c.action(action);
            const i0 = await c.interrupt();
            const r1 = await c.action(action);
            assertEquals(r0, 0);
            assertEquals(i0, "inject");
            assertEquals(r1, 1);
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "inject");
        result = await engine.replay(result.state);
        assert(result.type === "returned");
        assertSpyCalls(builder, 2);
        assertSpyCall(builder, 1, { returned: Promise.resolve(undefined) });
        assertEquals(i, 2);
        assertSpyCalls(action, 2);
        assertSpyCall(action, 0, { returned: 0 });
        assertSpyCall(action, 1, { returned: 1 });
    });
    it("should support parallel actions", async () => {
        let i = 0;
        const builder = spy(async (c: ReplayControls) => {
            const vals = await Promise.all([
                c.action(() => Promise.resolve(i++)),
                c.action(() => i++),
                c.action(() => Promise.resolve(i++)),
            ]);
            assertEquals(vals, [0, 1, 2]);
            await c.interrupt();
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        assertGreater(result.interrupts.length, 0);
        ReplayEngine.supply(result.state, result.interrupts[0], "inject");
        result = await engine.replay(result.state);
        assert(result.type === "returned");
        assertEquals(i, 3);
        assertSpyCalls(builder, 2);
        assertSpyCall(builder, 1, { returned: Promise.resolve(undefined) });
    });
    it("should support floating actions", async () => {
        let i = 0;
        const action = spy(() => Promise.resolve(i++));
        const builder = spy(async (c: ReplayControls) => {
            c.action(action);
            const int = await c.interrupt();
            c.action(action);
            const res = await c.action(action);
            assertEquals(int, "inject");
            assertEquals(res, 2);
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "inject");
        result = await engine.replay(result.state);
        assert(result.type === "returned");
        assertSpyCalls(builder, 2);
        assertSpyCall(builder, 1, { returned: Promise.resolve(undefined) });
        assertEquals(i, 3);
        assertSpyCalls(action, 3);
        assertSpyCall(action, 0, { returned: Promise.resolve(0) });
        assertSpyCall(action, 1, { returned: Promise.resolve(1) });
        assertSpyCall(action, 2, { returned: Promise.resolve(2) });
    });
    it("should not wait for floating actions", async () => {
        const action = spy(async () => {
            await new Promise<never>(() => {
                // never completes
            });
        });
        const builder = spy(async (c: ReplayControls) => {
            c.action(action);
            await c.interrupt();
            c.action(action);
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "inject");
        result = await engine.replay(result.state);
        assert(result.type === "returned");
        assertSpyCalls(builder, 2);
        assertSpyCall(builder, 1, { returned: Promise.resolve(undefined) });
        assertSpyCalls(action, 2);
    });
    it("should support parallel interrupts", async () => {
        let i = 0;
        const checkpoints: string[] = [];
        const action = spy(() => Promise.resolve(i++));
        const builder = spy(async (c: ReplayControls) => {
            let answer = 42;
            const i0 = c.interrupt().then(async (r0) => {
                checkpoints.push("i0");
                assertEquals(r0, "one");
                answer += Number(await c.action(action));
                const r00 = await c.interrupt();
                checkpoints.push("i00");
                assertEquals(r00, "three");
                const [r01, r02] = await Promise.all([
                    c.interrupt(),
                    c.interrupt(),
                ]);
                checkpoints.push("i01", "i02");
                assertEquals(r01, "five");
                assertEquals(r02, "six");
                return "A";
            });
            const i1 = c.interrupt().then(async (r1) => {
                checkpoints.push("i1");
                assertEquals(r1, "two");
                answer += Number(await c.action(action));
                const r10 = await c.interrupt();
                checkpoints.push("i10");
                assertEquals(r10, "four");
                return "B";
            });
            checkpoints.push("go");
            const [r0, r1] = await Promise.all([i0, i1]);
            assertEquals(r0, "A");
            assertEquals(r1, "B");
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        for (const inject of ["one", "two", "three", "four", "five", "six"]) {
            if (result.type !== "interrupted") console.log(result);
            assert(result.type === "interrupted");
            ReplayEngine.supply(result.state, result.interrupts[0], inject);
            result = await engine.replay(result.state);
        }
        assert(result.type === "returned");
        assertEquals(checkpoints, [
            // one line per replay
            ...["go"],
            ...["go", "i0"],
            ...["go", "i0", "i1"],
            ...["go", "i0", "i1", "i00"],
            ...["go", "i0", "i1", "i00", "i10"],
            ...["go", "i0", "i1", "i00", "i10"],
            ...["go", "i0", "i1", "i00", "i10", "i01", "i02"],
        ]);
        assertSpyCalls(builder, 7);
        assertSpyCall(builder, 6, { returned: Promise.resolve(undefined) });
        assertEquals(i, 2);
        assertSpyCalls(action, 2);
        assertSpyCall(action, 0, { returned: Promise.resolve(0) });
        assertSpyCall(action, 1, { returned: Promise.resolve(1) });
    });
    it("should support floating interrupts", async () => {
        let i = 0;
        const action = spy(() => i++);
        const builder = spy(async (c: ReplayControls) => {
            c.interrupt();
            const r0 = await c.action(action);
            assertEquals(r0, 0);
            const int = await c.interrupt();
            c.interrupt();
            const r1 = await c.action(action);
            assertEquals(int, "inject");
            assertEquals(r1, 1);
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        for (const inject of ["never", "inject", "never"]) {
            assert(result.type === "interrupted");
            ReplayEngine.supply(result.state, result.interrupts[0], inject);
            result = await engine.replay(result.state);
        }
        assert(result.type === "returned");
        assertSpyCalls(builder, 4);
        assertSpyCall(builder, 3, { returned: Promise.resolve(undefined) });
        assertEquals(i, 2);
        assertSpyCalls(action, 2);
        assertSpyCall(action, 0, { returned: 0 });
        assertSpyCall(action, 1, { returned: 1 });
    });
    it("supports canceling", async () => {
        let i = 0;
        const builder = spy(async (c: ReplayControls) => {
            const res = await c.action(() => i++);
            assertEquals(res, i - 1);
            await c.cancel();
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assertEquals(i, 1);
        assert(result.type === "interrupted");
        assertEquals(result.interrupts.length, 0);
        result = await engine.replay(result.state);
        assertEquals(i, 1);
        assert(result.type === "interrupted");
        assertEquals(result.interrupts.length, 0);
        assertSpyCalls(builder, 2);
        assertSpyCall(builder, 0, {
            returned: new Promise(() => {/* pending */}),
        });
        assertSpyCall(builder, 1, {
            returned: new Promise(() => {/* pending */}),
        });
    });
    it("supports floating cancel ops", async () => {
        let i = 0;
        const builder = spy(async (c: ReplayControls) => {
            const res0 = await c.interrupt();
            assertEquals(res0, "zero");
            c.cancel();
            const res1 = await c.interrupt();
            assertEquals(res1, "one");
            i++;
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "zero");
        result = await engine.replay(result.state);
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "one");
        result = await engine.replay(result.state);
        // interrupted due to cancel
        assert(result.type === "interrupted");
        assertEquals(result.interrupts, []);
        assertSpyCalls(builder, 3);
        assertEquals(i, 1);
    });
});
