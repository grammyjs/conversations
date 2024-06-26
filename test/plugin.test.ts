import { Composer, type Context } from "../src/deps.deno.ts";
import {
    type ConversationData,
    conversations,
    createConversation,
} from "../src/plugin.ts";
import {
    assertEquals,
    assertRejects,
    assertSpyCall,
    assertSpyCalls,
    assertThrows,
    describe,
    it,
    spy,
} from "./deps.test.ts";

describe("conversations", () => {
    const next = () => Promise.resolve();

    it("should read and write the storage", async () => {
        const ctx = {} as Context;
        const read = spy((): ConversationData => ({ convo: [] }));
        const write = spy(() => {});
        const del = spy(() => {});
        const plugin = conversations({ read, write, delete: del });
        const mw = new Composer();
        mw.use(plugin, createConversation(() => {}, "convo"));
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, { args: [ctx], returned: { convo: [] } });
        assertSpyCalls(write, 1);
        assertSpyCall(write, 0, { args: [ctx, { convo: [] }] });
        assertSpyCalls(del, 0);
    });
    it("shoud prevent double installations", async () => {
        const mw = new Composer();
        mw.use(
            conversations({
                read: () => ({}),
                write: () => {},
                delete: () => {},
            }),
            conversations({
                read: () => ({}),
                write: () => {},
                delete: () => {},
            }),
        );
        assertRejects(() =>
            Promise.resolve(mw.middleware()({} as Context, next))
        );
    });
    it("delete empty data", async () => {
        const ctx = {} as Context;
        const read = spy((): ConversationData => ({}));
        const write = spy(() => {});
        const del = spy(() => {});
        const plugin = conversations({ read, write, delete: del });
        const mw = new Composer();
        mw.use(plugin, createConversation(() => {}, "convo"));
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, { args: [ctx], returned: {} });
        assertSpyCalls(write, 0);
        assertSpyCalls(del, 1);
        assertSpyCall(del, 0, { args: [ctx] });
    });
    it("should skip unnecessary writes", async () => {
        const ctx = {} as Context;
        const read = spy((): ConversationData => ({ convo: [] }));
        const write = spy(() => {});
        const del = spy(() => {});
        const plugin = conversations({ read, write, delete: del });
        const mw = new Composer();
        mw.use(
            plugin,
            () => {/* abort */},
            createConversation(() => {}, "convo"), // unreachable
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, { args: [ctx], returned: { convo: [] } });
        assertSpyCalls(write, 0);
        assertSpyCalls(del, 0);
    });
});

describe("createConversation", () => {
    it("should make sure that conversations have a name", () => {
        assertEquals(typeof createConversation(() => {}, "convo"), "function");
        const convo2 = () => {};
        assertEquals(typeof createConversation(convo2), "function");
        assertEquals(
            typeof createConversation(function convo3() {}),
            "function",
        );
        assertThrows(() => createConversation(function () {}));
        assertThrows(() => createConversation(() => {}));
    });
});
