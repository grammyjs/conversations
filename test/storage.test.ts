import {
    Api,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import {
    pinVersion,
    uniformStorage,
    type VersionedState,
    type VersionedStateStorage,
} from "../src/storage.ts";
import { assertEquals, describe, it } from "./deps.test.ts";

describe("pinVersion", () => {
    it("should return the same data for the correct version", () => {
        const { versionify, unpack } = pinVersion(0);
        const data = { x: 4 };
        assertEquals(unpack(versionify(data)), data);
    });
    it("should drop data for mismatching versions", () => {
        const { versionify } = pinVersion(0);
        const { unpack } = pinVersion(1);
        const data = { x: 4 };
        assertEquals(unpack(versionify(data)), undefined);
    });
});

const id = 42;
function mkctx() {
    return new Context(
        { message: { chat: { id } } } as Update,
        new Api("dummy"),
        {} as UserFromGetMe,
    );
}
describe("uniformStorage", () => {
    it("should work with a default adapter", async () => {
        const s = uniformStorage<Context, number>()(mkctx());
        await s.write(3);
        assertEquals(await s.read(), 3);
        await s.delete();
        assertEquals(await s.read(), undefined);
    });
    it("should work with a custom adapter", async () => {
        let state: VersionedState<number> | undefined;
        const s = uniformStorage<Context, number>({
            read: (key) => {
                assertEquals(key, id.toString());
                return state;
            },
            write: (key, newState) => {
                assertEquals(key, id.toString());
                state = newState;
            },
            delete: (key) => {
                assertEquals(key, id.toString());
                state = undefined;
            },
        })(mkctx());
        await s.write(3);
        assertEquals(await s.read(), 3);
        await s.delete();
        assertEquals(await s.read(), undefined);
    });
    it("should work with a key adapter", async () => {
        let state: VersionedState<number> | undefined;
        const adapter: VersionedStateStorage<string, number> = {
            read: (key) => {
                assertEquals(key, id.toString());
                return state;
            },
            write: (key, newState) => {
                assertEquals(key, id.toString());
                state = newState;
            },
            delete: (key) => {
                assertEquals(key, id.toString());
                state = undefined;
            },
        };
        const s = uniformStorage<Context, number>({
            type: "key",
            adapter,
        })(mkctx());
        await s.write(3);
        assertEquals(await s.read(), 3);
        await s.delete();
        assertEquals(await s.read(), undefined);
    });
    it("should work with a custom key adapter", async () => {
        const customId = 2 ** id;
        let state: VersionedState<number> | undefined;
        const adapter: VersionedStateStorage<string, number> = {
            read: (key) => {
                assertEquals(key, customId.toString());
                return state;
            },
            write: (key, newState) => {
                assertEquals(key, customId.toString());
                state = newState;
            },
            delete: (key) => {
                assertEquals(key, customId.toString());
                state = undefined;
            },
        };
        const s = uniformStorage<Context, number>({
            type: "key",
            getStorageKey: (ctx) => (2 ** ctx.chatId!).toString(),
            adapter,
        })(mkctx());
        await s.write(3);
        assertEquals(await s.read(), 3);
        await s.delete();
        assertEquals(await s.read(), undefined);
    });
    it("should work with a context adapter", async () => {
        let state: VersionedState<number> | undefined;
        const ctx = mkctx();
        const adapter: VersionedStateStorage<Context, number> = {
            read: (c) => {
                assertEquals(c, ctx);
                return state;
            },
            write: (c, newState) => {
                assertEquals(c, ctx);
                state = newState;
            },
            delete: (c) => {
                assertEquals(c, ctx);
                state = undefined;
            },
        };
        const s = uniformStorage<Context, number>({
            type: "context",
            adapter,
        })(ctx);
        await s.write(3);
        assertEquals(await s.read(), 3);
        await s.delete();
        assertEquals(await s.read(), undefined);
    });
    it("should version its state", async () => {
        const ctx = mkctx();
        let state: VersionedState<number> | undefined;
        const s = uniformStorage<Context, number>({
            type: "key",
            version: 3,
            adapter: {
                read: (key) => {
                    assertEquals(key, id.toString());
                    return state;
                },
                write: (key, newState) => {
                    assertEquals(key, id.toString());
                    state = newState;
                },
                delete: (key) => {
                    assertEquals(key, id.toString());
                    state = undefined;
                },
            },
        })(ctx);
        await s.write(3);
        const t = uniformStorage<Context, number>({
            type: "key",
            version: 4,
            adapter: {
                read: (key) => {
                    assertEquals(key, id.toString());
                    return state;
                },
                write: (key, newState) => {
                    assertEquals(key, id.toString());
                    state = newState;
                },
                delete: (key) => {
                    assertEquals(key, id.toString());
                    state = undefined;
                },
            },
        })(ctx);
        assertEquals(await t.read(), undefined);
    });
});
