import {
    Api,
    Composer,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import {
    ConversationContext,
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

type TestContext = ConversationContext<Context>;
const next = () => Promise.resolve();
const emptyState: ConversationData[string][0] = {
    args: "[]",
    interrupts: [],
    replay: { send: [], receive: [] },
};

describe("conversations", () => {
    it("should read and write the storage", async () => {
        const ctx = {} as TestContext;
        const read = spy((): ConversationData => ({
            convo: [emptyState],
        }));
        const write = spy(() => {});
        const del = spy(() => {});
        const plugin = conversations({ read, write, delete: del });
        const mw = new Composer<TestContext>();
        mw.use(plugin, createConversation(() => {}, "convo"));
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, {
            args: [ctx],
            returned: { convo: [emptyState] },
        });
        assertSpyCalls(write, 1);
        assertSpyCall(write, 0, { args: [ctx, { convo: [emptyState] }] });
        assertSpyCalls(del, 0);
    });
    it("shoud prevent double installations", async () => {
        const mw = new Composer<TestContext>();
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
        await assertRejects(() =>
            Promise.resolve(mw.middleware()({} as TestContext, next))
        );
    });
    it("delete empty data", async () => {
        const ctx = {} as TestContext;
        const read = spy((): ConversationData => ({}));
        const write = spy(() => {});
        const del = spy(() => {});
        const plugin = conversations({ read, write, delete: del });
        const mw = new Composer<TestContext>();
        mw.use(plugin, createConversation(() => {}, "convo"));
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, { args: [ctx], returned: {} });
        assertSpyCalls(write, 0);
        assertSpyCalls(del, 1);
        assertSpyCall(del, 0, { args: [ctx] });
    });
    it("should skip unnecessary writes", async () => {
        const ctx = {} as TestContext;
        const read = spy((): ConversationData => ({ convo: [emptyState] }));
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({ read, write, delete: del }),
            () => {/* abort */},
            createConversation(() => {}, "convo"), // unreachable
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, {
            args: [ctx],
            returned: { convo: [emptyState] },
        });
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
        assertThrows(
            () => createConversation(function () {}),
            "without a name",
        );
        assertThrows(() => createConversation(() => {}), "without a name");
    });
    it("should make sure that the conversations plugin was installed", async () => {
        const ctx = {} as TestContext;
        const mw = new Composer<TestContext>();
        mw.use(createConversation(() => {}, "convo"));
        await assertRejects(() => Promise.resolve(mw.middleware()(ctx, next)));
    });
    describe("via ctx.conversation", () => {
        it("should support entering conversations", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                (ctx) => ctx.conversation.enter("convo"),
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].convo.length, 1); // one active
            assertSpyCalls(del, 0);
        });
        it("should throw when entering a conversation with an unknown name", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                (ctx) => ctx.conversation.enter("unknown"),
            );
            await assertRejects(() =>
                Promise.resolve(mw.middleware()(ctx, next))
            );
            assertEquals(i, 0);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 0);
        });
        it("should throw an error if a conversation was already entered", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await assertRejects(() => ctx.conversation.enter("convo"));
                    j++;
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertEquals(j, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].convo.length, 1); // one active
            assertSpyCalls(del, 0);
        });
        it("should support entering parallel conversations", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await ctx.conversation.enter("convo", { parallel: true });
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 2);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].convo.length, 2); // two active
            assertSpyCalls(del, 0);
        });
        it("should support conversations that completely immediately after being entered", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy(() => {});
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(() => {
                    i++;
                }, "convo"),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    assertEquals(ctx.conversation.active("convo"), 0);
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 1);
            assertSpyCall(del, 0, { args: [ctx] });
        });
        it("should support conversations that throw immediately after being entered", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy(() => {});
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            const err = new Error("nope");
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(() => {
                    throw err;
                }, "convo"),
                async (ctx) => {
                    try {
                        await ctx.conversation.enter("convo");
                    } catch (e) {
                        assertEquals(e, err);
                    }
                    assertEquals(ctx.conversation.active("convo"), 0);
                },
            );
            await mw.middleware()(ctx, next);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 1);
            assertSpyCall(del, 0, { args: [ctx] });
        });
        it("should support conversations that skip immediately after being entered", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    i++;
                    await c.skip();
                    i++;
                }, "convo"),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    assertEquals(ctx.conversation.active("convo"), 1);
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].convo.length, 1);
            assertSpyCalls(del, 0);
        });
        // TODO: enter and wait and resume
        // TODO: enter and inspect active
        // TODO: resume and inspect active
        // TODO: enter parallel inspect all active
        // TODO: enter without await
        // TODO: concurrent enter without parallel
        // TODO: concurrent enter with parallel
        // TODO: enter and exit
        // TODO: resume and exit
        // TODO: exit all
        // TODO: exit first
        // TODO: exit last
        // TODO: install conversations inside conversation
        // TODO: concurrent enter and exit
    });
    // TODO: resume without parallel
    // TODO: resume with parallel
    // TODO: resume and handle error
    // TODO: resume and exit
    // TODO: resume and skip
    // TODO: resume and halt
    // TODO: do not touch conversations with a different name
    // TODO: wait
    // TODO: skip
    // TODO: halt
    // TODO: external with plain data
    // TODO: external with custom serialsation for values
    // TODO: external with custom serialsation for errors
    // TODO: run
    // TODO: concurrent wait/skip/halt/external/run
    // TODO: common cases such as loops with side-effects, or floating checks
});
