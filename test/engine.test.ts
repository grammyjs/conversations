import {
    assert,
    assertEquals,
} from "https://deno.land/std@0.177.1/testing/asserts.ts";
import { describe, it } from "https://deno.land/std@0.177.1/testing/bdd.ts";
import {
    assertSpyCalls,
    spy,
} from "https://deno.land/std@0.177.1/testing/mock.ts";
import { type ReplayControls, ReplayEngine } from "../src/engine.ts";

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
            await c.interrupt();
            await c.interrupt();
        });
        const engine = new ReplayEngine(builder);
        let result = await engine.play();
        assert(result.type === "interrupted");
        ReplayEngine.supply(result, "zero");
        result = await engine.replay(result);
        assert(result.type === "interrupted");
        ReplayEngine.supply(result, "one");
        result = await engine.replay(result);
        assert(result.type === "returned");
    });
});
