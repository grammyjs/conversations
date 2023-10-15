import {
    assert,
    assertEquals,
    assertFalse,
} from "https://deno.land/std@0.177.1/testing/asserts.ts";
import { describe, it } from "https://deno.land/std@0.177.1/testing/bdd.ts";
import { resolver } from "../src/resolve.ts";

describe("resolver", () => {
    it("resolves to a value", async () => {
        const r = resolver();
        assertFalse(r.isResolved());
        assertEquals(r.value, undefined);
        r.resolve("value");
        assertEquals(await r.promise, "value");
        assert(r.isResolved());
        assertEquals(r.value, "value");
    });
    it("resolves a default value", async () => {
        const r = resolver("value");
        assertFalse(r.isResolved());
        assertEquals(r.value, "value");
        r.resolve();
        assertEquals(await r.promise, "value");
        assert(r.isResolved());
        assertEquals(r.value, "value");
    });
    it("prefers a resolved value over its default", async () => {
        const r = resolver("initial");
        assertFalse(r.isResolved());
        assertEquals(r.value, "initial");
        r.resolve("value");
        assertEquals(await r.promise, "value");
        assert(r.isResolved());
        assertEquals(r.value, "value");
    });
});
