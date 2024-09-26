import { type ReplayControls, ReplayEngine } from "../src/engine.ts";
import { resolver } from "../src/resolve.ts";
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
            const res0 = await c.interrupt("a");
            assertEquals(res0, "zero");
            const res1 = await c.interrupt("b");
            assertEquals(res1, "one");
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        assertEquals(result.interrupts.length, 1);
        ReplayEngine.supply(result.state, result.interrupts[0], "zero");
        result = await engine.replay(result.state);
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "one");
        assertEquals(result.interrupts.length, 1);
        result = await engine.replay(result.state);
        assert(result.type === "returned");
        assertSpyCalls(builder, 3);
    });
    it("should support actions", async () => {
        let i = 0;
        const action = spy(() => i++);
        const builder = spy(async (c: ReplayControls) => {
            const r0 = await c.action(action, "a");
            const i0 = await c.interrupt("i");
            const r1 = await c.action(action, "b");
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
                c.action(() => Promise.resolve(i++), "a"),
                c.action(() => i++, "b"),
                c.action(() => Promise.resolve(i++), "c"),
            ]);
            assertEquals(vals, [0, 1, 2]);
            await c.interrupt("i");
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
            let order = "a";
            c.action(action, "x").then(() => order += "b");
            const int = await c.interrupt("i");
            order += "c";
            c.action(action, "y").then(() => order += "e");
            order += "d";
            const res = await c.action(action, "z");
            order += "f";
            assertEquals(int, "inject");
            assertEquals(res, 2);
            assertEquals(order, "abcdef");
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
    it("should wait for floating actions", async () => {
        let resolveAction = resolver();
        let resolvePlay = resolver();
        const action = spy(async () => {
            await resolveAction.promise;
        });
        const builder = spy(async (c: ReplayControls) => {
            c.action(action, "a");
            resolvePlay.resolve();
            const inject = await c.interrupt("i");
            assertEquals(inject, "inject");
            c.action(action, "b");
            resolvePlay.resolve();
        });
        const engine = new ReplayEngine(builder);

        let resultP = engine.play();
        await resolvePlay.promise;
        resolvePlay = resolver();
        assertSpyCalls(action, 1);
        assertSpyCall(action, 0, {
            returned: new Promise<never>(() => {/* pending */}),
        });
        resolveAction.resolve();
        resolveAction = resolver();
        let result = await resultP;
        assert(result.type === "interrupted");
        assertSpyCalls(action, 1);
        assertSpyCall(action, 0, { returned: Promise.resolve(undefined) });

        ReplayEngine.supply(result.state, result.interrupts[0], "inject");
        resultP = engine.replay(result.state);
        await resolvePlay.promise;
        assertSpyCalls(action, 1);
        resolveAction.resolve();
        result = await resultP;
        assertSpyCalls(action, 2);
        assertSpyCall(action, 1, {
            returned: new Promise<never>(() => {/* pending */}),
        });
        assert(result.type === "returned");
        assertSpyCalls(builder, 2);
        assertSpyCalls(action, 2);
        assertSpyCall(action, 1, { returned: Promise.resolve(undefined) });
    });
    it("should support parallel interrupts", async () => {
        let i = 0;
        const checkpoints: string[] = [];
        const action = spy(() => Promise.resolve(i++));
        const builder = spy(async (c: ReplayControls) => {
            let answer = 42;
            const i0 = c.interrupt("a").then(async (r0) => {
                checkpoints.push("i0");
                assertEquals(r0, "one");
                answer += Number(await c.action(action, "0"));
                const r00 = await c.interrupt("b");
                checkpoints.push("i00");
                assertEquals(r00, "three");
                const [r01, r02] = await Promise.all([
                    c.interrupt("c"),
                    c.interrupt("d"),
                ]);
                checkpoints.push("i01", "i02");
                assertEquals(r01, "five");
                assertEquals(r02, "six");
                return "A";
            });
            const i1 = c.interrupt("e").then(async (r1) => {
                checkpoints.push("i1");
                assertEquals(r1, "two");
                answer += Number(await c.action(action, "1"));
                const r10 = await c.interrupt("f");
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
            ...["go", "i0", "i1", "i00", "i10"], // all
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
        const action = spy(() =>
            new Promise((r) => setTimeout(() => r(i++), 0))
        );
        let initialPlay = true;
        const builder = spy(async (c: ReplayControls) => {
            c.interrupt("x");
            const r0 = await c.action(action, "a");
            assertEquals(r0, 0);
            await c.action(() => assert(initialPlay), "b");
            const int = await c.interrupt("y");
            const r1 = await c.action(action, "c");
            assertEquals(int, "inject");
            assertEquals(r1, 1);
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        initialPlay = false;
        for (const inject of ["never", "inject"]) {
            assertEquals(result.type, "interrupted");
            assert(result.type === "interrupted");
            ReplayEngine.supply(result.state, result.interrupts[0], inject);
            result = await engine.replay(result.state);
        }
        assert(result.type === "returned");
        assertSpyCalls(builder, 3);
        assertSpyCall(builder, 2, { returned: Promise.resolve(undefined) });
        assertEquals(i, 2);
        assertSpyCalls(action, 2);
        assertSpyCall(action, 0, { returned: Promise.resolve(0) });
        assertSpyCall(action, 1, { returned: Promise.resolve(1) });
    });
    it("should discard dangling interrupts upon return", async () => {
        let i = 0;
        let j = 0;
        const action = spy(() => i++);
        const builder = spy(async (c: ReplayControls) => {
            c.interrupt("x").then(() => {
                c.action(action, "a");
            });
            await c.interrupt("y");
            c.interrupt("z"); // never resolves
            j++;
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        for (const inject of ["floating", "awaited"]) {
            assert(result.type === "interrupted");
            ReplayEngine.supply(result.state, result.interrupts[0], inject);
            result = await engine.replay(result.state);
        }
        if (result.type !== "returned") console.log(result);
        assert(result.type === "returned");
        assertSpyCalls(builder, 3);
        assertEquals(i, 1);
        assertEquals(j, 1);
        assertSpyCalls(action, 1);
        assertSpyCall(action, 0, { returned: 0 });
    });
    it("should support cascading interrupts", async () => {
        let i = 0;
        const builder = spy(async (c: ReplayControls) => {
            const rsr = resolver();
            c.interrupt("a").then((i0) => {
                c.interrupt("b").then((i1) => {
                    c.interrupt("c").then((i2) => {
                        assertEquals([i0, i1, i2], ["one", "two", "three"]);
                        i++;
                        rsr.resolve();
                    });
                });
            });
            await rsr.promise; // do not finish function before cascade
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        for (const inject of ["one", "two", "three"]) {
            assert(result.type === "interrupted");
            ReplayEngine.supply(result.state, result.interrupts[0], inject);
            result = await engine.replay(result.state);
        }
        assert(result.type === "returned");
        assertSpyCalls(builder, 4);
        assertEquals(i, 1);
    });
    it("should support cascading interrupts and actions", async () => {
        let inner = false;
        let i = 0;
        const action = spy(() => i++);
        const builder = spy(async (c: ReplayControls) => {
            const rsr = resolver();
            c.interrupt("0").then((i0) => {
                assertEquals(i0, "one");
                c.action(action, "a").then((r0) => {
                    assertEquals(r0, 0);
                    c.interrupt("1").then((i1) => {
                        assertEquals(i1, "two");
                        c.action(action, "b").then(async (r1) => {
                            assertEquals(r1, 1);
                            assertEquals(await c.interrupt("2"), "three");
                            inner = true;
                            rsr.resolve();
                        });
                    });
                });
            });
            await rsr.promise;
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        for (const inject of ["one", "two", "three"]) {
            if (result.type !== "interrupted") console.log(inject);
            assertEquals(result.type, "interrupted");
            assert(result.type === "interrupted");
            ReplayEngine.supply(result.state, result.interrupts[0], inject);
            result = await engine.replay(result.state);
        }
        assert(result.type === "returned");
        assert(inner);
        assertSpyCalls(builder, 4);
        assertSpyCall(builder, 3, { returned: Promise.resolve(undefined) });
        assertEquals(i, 2);
        assertSpyCalls(action, 2);
        assertSpyCall(action, 0, { returned: 0 });
        assertSpyCall(action, 1, { returned: 1 });
    });
    it("should support canceling", async () => {
        let i = 0;
        const builder = spy(async (c: ReplayControls) => {
            const res = await c.action(() => i++, "a");
            assertEquals(res, i - 1);
            await c.cancel("x");
        });
        const engine = new ReplayEngine(builder);
        const result = await engine.play();
        assertEquals(i, 1);
        assert(result.type === "canceled");
        assertEquals(result.message, "x");
        assertSpyCalls(builder, 1);
        assertSpyCall(builder, 0, {
            returned: new Promise(() => {/* pending */}),
        });
    });
    it("should support floating cancel ops", async () => {
        let i = 0;
        const builder = spy(async (c: ReplayControls) => {
            const res0 = await c.interrupt("x");
            assertEquals(res0, "zero");
            c.cancel("y");
            // The interrupt has no effect since we already called cancel
            const res1 = await c.interrupt("z");
            assertEquals(res1, "one");
            i++;
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result.state, result.interrupts[0], "zero");
        result = await engine.replay(result.state);
        assert(result.type === "canceled"); // canceled not interrupted
        assertEquals(result.message, "y");
        assertSpyCalls(builder, 2);
        assertEquals(i, 0);
    });
});
