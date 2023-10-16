import {
    assert,
    assertEquals,
    assertFalse,
    describe,
    it,
} from "./deps.test.ts";
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
