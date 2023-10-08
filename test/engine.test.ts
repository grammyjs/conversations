import { assertEquals } from "https://deno.land/std@0.177.1/testing/asserts.ts";
import { describe, it } from "https://deno.land/std@0.177.1/testing/bdd.ts";
import {
    assertSpyCall,
    assertSpyCallArg,
    assertSpyCalls,
    spy,
} from "https://deno.land/std@0.177.1/testing/mock.ts";
import { type ReplayControls, ReplayEngine } from "../src/engine.ts";

describe("ReplayEngine", () => {
    it("should run the builder function", async () => {
        const arg = "input";
        const out = Promise.resolve("output");
        const builder = spy((_c: ReplayControls, s: string) => {
            assertEquals(s, arg);
            return out;
        });
        const engine = new ReplayEngine(builder);
        const res = await engine.play([arg]);
        assertEquals(res.returned, await out);
        assertSpyCalls(builder, 1);
        assertSpyCall(builder, 0, { returned: out });
        assertSpyCallArg(builder, 0, 1, arg);
    });
    it("should replay with the same arguments", async () => {
        const arg = "input";
        const builder = spy((_c: ReplayControls, s: string) => {
            assertEquals(s, arg);
        });
        const engine = new ReplayEngine(builder);
        const { state } = await engine.play([arg]);
        await engine.replay(state);
        assertSpyCalls(builder, 2);
        assertSpyCallArg(builder, 0, 1, arg);
        assertSpyCallArg(builder, 1, 1, arg);
    });
});
