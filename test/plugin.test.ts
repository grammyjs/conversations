import {
    Api,
    Composer,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import {
    type ConversationBuilder,
    type ConversationData,
    type ConversationFlavor,
    conversations,
    createConversation,
    enterConversation,
    resumeConversation,
} from "../src/plugin.ts";
import { resolver } from "../src/resolve.ts";
import { pinVersion, type VersionedState } from "../src/storage.ts";
import {
    assert,
    assertEquals,
    assertInstanceOf,
    assertNotStrictEquals,
    assertRejects,
    assertSpyCall,
    assertSpyCalls,
    assertStrictEquals,
    assertThrows,
    describe,
    it,
    spy,
} from "./deps.test.ts";

type TestContext = ConversationFlavor<Context>;
function mkctx(update: unknown = { message: { chat: { id: 42 } } }) {
    return new Context(
        update as Update,
        new Api("dummy"),
        {} as UserFromGetMe,
    ) as TestContext;
}
const next = () => Promise.resolve();
const { versionify } = pinVersion(0);
const emptyState: ConversationData[string][0] = {
    args: "[]",
    interrupts: [],
    replay: { send: [], receive: [] },
};

describe("conversations", () => {
    it("should read and write the storage", async () => {
        const ctx = mkctx();
        const read = spy((): VersionedState<ConversationData> =>
            versionify({ convo: [emptyState] })
        );
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({
                storage: {
                    type: "context",
                    adapter: { read, write, delete: del },
                },
            }),
            createConversation(() => {}, "convo"),
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, {
            args: [ctx],
            returned: versionify({ convo: [emptyState] }),
        });
        assertSpyCalls(write, 1);
        assertSpyCall(write, 0, {
            args: [ctx, versionify({ convo: [emptyState] })],
        });
        assertSpyCalls(del, 0);
    });
    it("should read and write the storage with custom getStorageKey", async () => {
        const ctx = mkctx();
        const getStorageKey = () => "key";
        const read = spy((): VersionedState<ConversationData> =>
            versionify({ convo: [emptyState] })
        );
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({
                storage: {
                    type: "key",
                    getStorageKey,
                    adapter: { read, write, delete: del },
                },
            }),
            createConversation(() => {}, "convo"),
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, {
            args: ["key"],
            returned: versionify({ convo: [emptyState] }),
        });
        assertSpyCalls(write, 1);
        assertSpyCall(write, 0, {
            args: ["key", versionify({ convo: [emptyState] })],
        });
        assertSpyCalls(del, 0);
    });
    it("shoud prevent double installations", async () => {
        const mw = new Composer<TestContext>();
        mw.use(conversations(), conversations());
        await assertRejects(() =>
            Promise.resolve(mw.middleware()(mkctx(), next))
        );
    });
    it("should delete empty data", async () => {
        const ctx = mkctx();
        const read = spy((): VersionedState<ConversationData> =>
            versionify({ convo: [] })
        );
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({
                storage: {
                    type: "context",
                    adapter: { read, write, delete: del },
                },
            }),
            createConversation(() => {}, "convo"),
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, { args: [ctx], returned: versionify({}) });
        assertSpyCalls(write, 0);
        assertSpyCalls(del, 1);
        assertSpyCall(del, 0, { args: [ctx] });
    });
    it("should delete empty data with custom getStorageKey", async () => {
        const ctx = mkctx();
        const getStorageKey = () => "key";
        const read = spy((): VersionedState<ConversationData> =>
            versionify({ convo: [] })
        );
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({
                storage: {
                    type: "key",
                    getStorageKey,
                    adapter: { read, write, delete: del },
                },
            }),
            createConversation(() => {}, "convo"),
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, { args: ["key"], returned: versionify({}) });
        assertSpyCalls(write, 0);
        assertSpyCalls(del, 1);
        assertSpyCall(del, 0, { args: ["key"] });
    });
    it("should skip unnecessary writes", async () => {
        const ctx = mkctx();
        const read = spy((): VersionedState<ConversationData> =>
            versionify({ convo: [emptyState] })
        );
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({
                storage: {
                    type: "context",
                    adapter: { read, write, delete: del },
                },
            }),
            () => {/* abort */},
            createConversation(() => {}, "convo"), // unreachable
        );
        await mw.middleware()(ctx, next);
        assertSpyCalls(read, 1);
        assertSpyCall(read, 0, {
            args: [ctx],
            returned: versionify({ convo: [emptyState] }),
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
        const ctx = mkctx();
        const mw = new Composer<TestContext>();
        mw.use(createConversation(() => {}, "convo"));
        await assertRejects(() => Promise.resolve(mw.middleware()(ctx, next)));
    });
    it("should support plugins", async () => {
        const mw = new Composer<TestContext>();
        let i = 0;

        type PluginContext = TestContext & {
            phi: number;
            prop: number;
        };
        mw.use(
            conversations({
                plugins: [async (ctx, next) => {
                    Object.assign(ctx, { phi: 0.5 * (1 + Math.sqrt(5)) });
                    await next();
                }],
            }),
            createConversation(async (convo, ctx: PluginContext) => {
                assertEquals(ctx.prop, 42);
                ctx = await convo.wait();
                assertEquals(ctx.prop, 42);
                assertEquals(Math.round(ctx.phi), 2);
                i++;
            }, {
                id: "convo",
                plugins: [async (ctx, next) => {
                    Object.assign(ctx, { prop: 0 });
                    await next();
                }, async (ctx, next) => {
                    Object.assign(ctx, { prop: 42 });
                    await next();
                }],
            }),
            (ctx) => ctx.conversation.enter("convo"),
        );
        await mw.middleware()(mkctx(), next);
        await mw.middleware()(mkctx(), next);
        assertEquals(i, 1);
    });
    it("should halt the conversation upon default wait timeout", async () => {
        const onExit = spy(() => {});
        const mw = new Composer<TestContext>();
        let enter = true;
        let i = 0;
        let j = 0;
        mw.use(
            conversations({ onExit }),
            createConversation(async (convo) => {
                i++;
                await convo.wait();
                j++;
            }, { id: "convo", maxMillisecondsToWait: 1 }),
            async (ctx) => {
                if (!enter) return;
                enter = false;
                await ctx.conversation.enter("convo");
            },
        );
        const up = { message: { chat: { id: 0 } } };
        await mw.middleware()(mkctx(up), next);
        await new Promise((r) => setTimeout(r, 5));
        await mw.middleware()(mkctx(up), next);
        assertEquals(i, 2);
        assertEquals(j, 0);
        assertSpyCalls(onExit, 1);
        assertSpyCall(onExit, 0, { args: ["convo"] });
    });
    it("should continue if default wait timeouts do not kick in", async () => {
        const onExit = spy(() => {});
        const mw = new Composer<TestContext>();
        let enter = true;
        let i = 0;
        let j = 0;
        mw.use(
            conversations({ onExit }),
            createConversation(async (convo) => {
                i++;
                await convo.wait();
                j++;
            }, { id: "convo", maxMillisecondsToWait: 100 }),
            async (ctx) => {
                if (!enter) return;
                enter = false;
                await ctx.conversation.enter("convo");
            },
        );
        const up = { message: { chat: { id: 0 } } };
        await mw.middleware()(mkctx(up), next);
        await new Promise((r) => setTimeout(r, 5));
        await mw.middleware()(mkctx(up), next);
        assertEquals(i, 2);
        assertEquals(j, 1);
    });
    it("should halt the conversation upon wait timeout", async () => {
        const onExit = spy(() => {});
        const mw = new Composer<TestContext>();
        let enter = true;
        let i = 0;
        let j = 0;
        mw.use(
            conversations({ onExit }),
            createConversation(async (convo) => {
                i++;
                await convo.wait({ maxMilliseconds: 1 });
                j++;
            }, "convo"),
            async (ctx) => {
                if (!enter) return;
                enter = false;
                await ctx.conversation.enter("convo");
            },
        );
        const up = { message: { chat: { id: 0 } } };
        await mw.middleware()(mkctx(up), next);
        await new Promise((r) => setTimeout(r, 5));
        await mw.middleware()(mkctx(up), next);
        assertEquals(i, 2);
        assertEquals(j, 0);
        assertSpyCalls(onExit, 1);
        assertSpyCall(onExit, 0, { args: ["convo"] });
    });
    it("should continue if wait timeouts do not kick in", async () => {
        const onExit = spy(() => {});
        const mw = new Composer<TestContext>();
        let enter = true;
        let i = 0;
        let j = 0;
        mw.use(
            conversations({ onExit }),
            createConversation(async (convo) => {
                i++;
                await convo.wait({ maxMilliseconds: 100 });
                j++;
            }, "convo"),
            async (ctx) => {
                if (!enter) return;
                enter = false;
                await ctx.conversation.enter("convo");
            },
        );
        const up = { message: { chat: { id: 0 } } };
        await mw.middleware()(mkctx(up), next);
        await new Promise((r) => setTimeout(r, 5));
        await mw.middleware()(mkctx(up), next);
        assertEquals(i, 2);
        assertEquals(j, 1);
    });
    describe("via ctx.conversation", () => {
        it("should support entering conversations", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c, ctx, arg0, arg1, arg2) => {
                    assertInstanceOf(ctx, Context);
                    assertEquals(arg0, -1);
                    assertEquals(arg1, "str");
                    assertEquals(arg2, { prop: [] });
                    i++;
                    await c.wait();
                }, "convo"),
                (ctx) =>
                    ctx.conversation.enter("convo", -1, "str", { prop: [] }),
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 1); // one active
            assertSpyCalls(del, 0);
        });
        it("should throw when entering a conversation with an unknown name", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
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
        it("should throw an error if the same conversation was already entered", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
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
            assertEquals(write.calls[0].args[1].state.convo.length, 1); // one active
            assertSpyCalls(del, 0);
        });
        it("should throw an error if a different conversation was already entered", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            let k = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                createConversation(async (c) => {
                    j++;
                    await c.wait();
                }, "other"),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await assertRejects(() => ctx.conversation.enter("other"));
                    k++;
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertEquals(j, 0);
            assertEquals(k, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(Object.keys(write.calls[0].args[1].state), ["convo"]);
            assertEquals(write.calls[0].args[1].state.convo.length, 1); // one active
            assertSpyCalls(del, 0);
        });
        it("should support entering parallel conversations for the same conversation", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, { id: "convo", parallel: true }),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await ctx.conversation.enter("convo");
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 2);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 2); // two active
            assertSpyCalls(del, 0);
        });
        it("should support entering parallel conversations for other conversations", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, { id: "convo", parallel: true }),
                createConversation(async (c) => {
                    j++;
                    await c.wait();
                }, { id: "other", parallel: true }),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await ctx.conversation.enter("other");
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertEquals(j, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 1); // one active
            assertEquals(write.calls[0].args[1].state.other.length, 1); // one active
            assertSpyCalls(del, 0);
        });
        it("should support conversations that complete immediately after being entered", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(() => {});
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
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
            assertSpyCalls(del, 0);
        });
        it("should support conversations that throw immediately after being entered", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(() => {});
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            const err = new Error("nope");
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
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
            assertSpyCalls(del, 0);
        });
        it("should support conversations that skip immediately after being entered", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
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
            assertEquals(write.calls[0].args[1].state.convo.length, 1);
            assertSpyCalls(del, 0);
        });
        it("should support entering and resuming conversations", async () => {
            let ctx = mkctx();
            let state: VersionedState<ConversationData> = versionify({});
            const read = spy((_ctx: Context) => state);
            const write = spy(
                (_ctx: Context, data: VersionedState<ConversationData>) => {
                    state = data;
                },
            );
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                    j++;
                }, "convo"),
                (ctx) => ctx.conversation.enter("convo"),
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertEquals(j, 0);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 1);
            assertSpyCalls(del, 0);
            ctx = mkctx();
            await mw.middleware()(ctx, next);
            assertEquals(i, 2);
            assertEquals(j, 1);
            assertSpyCalls(read, 2);
            assertSpyCall(read, 1, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertSpyCalls(del, 1);
            assertSpyCall(del, 0, { args: [ctx] });
        });
        it("should allow inspecting unknown active conversations", async () => {
            let i = 0;
            const mw = new Composer<TestContext>();
            mw.use(conversations(), (ctx) => {
                assertEquals(ctx.conversation.active("nope"), 0);
                assertEquals(ctx.conversation.active(), {});
                i++;
            });
            await mw.middleware()(mkctx(), next);
            assertEquals(i, 1);
        });
        it("should support inspecting active conversations", async () => {
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            let j = 0;
            const mw = new Composer<TestContext>();
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    await c.wait();
                }, { id: "convo", parallel: true }),
                createConversation(async (c) => {
                    await c.wait();
                }, { id: "other", parallel: true }),
                async (ctx) => {
                    const len = 3;
                    for (let i = 0; i < len; i++) {
                        await ctx.conversation.enter("convo");
                        assertEquals(ctx.conversation.active("convo"), i + 1);
                        assertEquals(ctx.conversation.active(), {
                            convo: i + 1,
                        });
                    }
                    await ctx.conversation.enter("other");

                    assertEquals(ctx.conversation.active("convo"), len);
                    assertEquals(ctx.conversation.active("other"), 1);
                    assertEquals(ctx.conversation.active(), {
                        convo: len,
                        other: 1,
                    });
                    j++;
                },
            );
            await mw.middleware()(mkctx(), next);
            assertEquals(j, 1);
        });
        it("should throw when entering conversations after middleware is done", async () => {
            const ctx = mkctx();
            const mw = new Composer<TestContext>();

            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});

            let i = 0;
            const outer = resolver();
            let p: Promise<unknown>;

            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                (ctx) => {
                    p = outer.promise.then(() =>
                        ctx.conversation.enter("convo")
                    );
                },
            );
            await mw.middleware()(ctx, next);
            outer.resolve();
            await assertRejects(() => p);

            assertEquals(i, 0);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 0);
        });
        it("should throw when entering conversations without await", async () => {
            const ctx = mkctx();
            const mw = new Composer<TestContext>();

            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});

            let i = 0;
            let p: Promise<unknown> | undefined;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                (ctx) => {
                    p = assertRejects(() => ctx.conversation.enter("convo"))
                        .then(() => i++);
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            await p;
            assertEquals(i, 2);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 0);
        });
        it("should detect if the same conversation is entered twice concurrently", async () => {
            const ctx = mkctx();
            const mw = new Composer<TestContext>();

            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});

            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                async (ctx) => {
                    const [c0, c1] = await Promise.allSettled([
                        ctx.conversation.enter("convo"),
                        ctx.conversation.enter("convo"),
                    ]);
                    assertEquals(c0.status, "fulfilled");
                    assertEquals(c1.status, "rejected");
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 1); // only stored first one
            assertSpyCalls(del, 0);
        });
        it("should support entering concurrently with parallel", async () => {
            const ctx = mkctx();
            const mw = new Composer<TestContext>();

            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});

            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, { id: "convo", parallel: true }),
                async (ctx) => {
                    const [c0, c1] = await Promise.allSettled([
                        ctx.conversation.enter("convo"),
                        ctx.conversation.enter("convo"),
                    ]);
                    assertEquals(c0.status, "fulfilled");
                    assertEquals(c1.status, "fulfilled");
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 2);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 2); // only stored first one
            assertSpyCalls(del, 0);
        });
        it("should support entering and immediately exiting conversations", async () => {
            const ctx = mkctx();
            let state: VersionedState<ConversationData> = versionify({});
            const read = spy((_ctx: Context) => state);
            const write = spy(
                (_ctx: Context, data: VersionedState<ConversationData>) => {
                    state = data;
                },
            );
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await ctx.conversation.exit("convo");
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 0);
        });
        it("should support resuming and exiting a conversation", async () => {
            let ctx = mkctx();
            let state: VersionedState<ConversationData> = versionify({});
            const read = spy((_ctx: Context) => state);
            const write = spy(
                (_ctx: Context, data: VersionedState<ConversationData>) => {
                    state = data;
                },
            );
            const del = spy((_ctx: Context) => {});
            let mw = new Composer<TestContext>();
            let i = 0;
            const plugin = conversations({
                storage: {
                    type: "context",
                    adapter: { read, write, delete: del },
                },
            });
            mw.use(
                plugin,
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
            assertEquals(write.calls[0].args[1].state.convo.length, 1);
            assertSpyCalls(del, 0);

            ctx = mkctx();
            mw = new Composer<TestContext>();
            mw.use(plugin, (ctx) => ctx.conversation.exit("convo"));
            await mw.middleware()(ctx, next);
            assertSpyCalls(read, 2);
            assertSpyCall(read, 1, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertSpyCalls(del, 1);
            assertSpyCall(del, 0, { args: [ctx] });
        });
        it("should support entering and exiting all conversations", async () => {
            let ctx = mkctx();
            let state: VersionedState<ConversationData> = versionify({});
            const read = spy((_ctx: Context) => state);
            const write = spy(
                (_ctx: Context, data: VersionedState<ConversationData>) => {
                    state = data;
                },
            );
            const del = spy((_ctx: Context) => {});
            let mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            const plugin = conversations({
                storage: {
                    type: "context",
                    adapter: { read, write, delete: del },
                },
            });
            mw.use(
                plugin,
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, { id: "convo", parallel: true }),
                createConversation(async (c) => {
                    j++;
                    await c.wait();
                }, { id: "other", parallel: true }),
                async (ctx) => {
                    await ctx.conversation.enter("convo");
                    await ctx.conversation.enter("convo");
                    await ctx.conversation.enter("other");
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 2);
            assertEquals(j, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertEquals(write.calls[0].args[0], ctx);
            assertEquals(write.calls[0].args[1].state.convo.length, 2);
            assertEquals(write.calls[0].args[1].state.other.length, 1);
            assertSpyCalls(del, 0);

            ctx = mkctx();
            mw = new Composer<TestContext>();
            mw.use(plugin, (ctx) => ctx.conversation.exitAll());
            await mw.middleware()(ctx, next);
            assertSpyCalls(read, 2);
            assertSpyCall(read, 1, { args: [ctx] });
            assertSpyCalls(write, 1);
            assertSpyCalls(del, 1);
            assertSpyCall(del, 0, { args: [ctx] });
        });
        const targets = ["first", "second", "last"];
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
            it("should support entering and exiting one of many parallel conversations", async () => {
                let ctx = mkctx();
                let state: VersionedState<ConversationData> = versionify({});
                const read = spy((_ctx: Context) => state);
                const write = spy(
                    (_ctx: Context, data: VersionedState<ConversationData>) => {
                        state = data;
                    },
                );
                const del = spy((_ctx: Context) => {});
                const onEnter = spy(() => {});
                const onExit = spy(() => {});
                let mw = new Composer<TestContext>();
                let i = 0;
                const res: string[] = [];
                const plugin = conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                    onEnter,
                    onExit,
                });
                const convo = createConversation(async (c, _, id: string) => {
                    i++;
                    await c.wait();
                    res.push(id);
                }, { id: "convo", parallel: true });
                mw.use(
                    plugin,
                    convo,
                    async (ctx) => {
                        for (const target of targets) {
                            await ctx.conversation.enter("convo", target);
                        }
                    },
                );
                await mw.middleware()(ctx, next);
                assertEquals(i, 3);
                assertSpyCalls(read, 1);
                assertSpyCall(read, 0, { args: [ctx] });
                assertSpyCalls(write, 1);
                assertEquals(write.calls[0].args[0], ctx);
                assertEquals(write.calls[0].args[1].state.convo.length, 3);
                assertSpyCalls(del, 0);

                ctx = mkctx();
                mw = new Composer<TestContext>(
                    plugin,
                    (ctx) => ctx.conversation.exitOne("convo", targetIndex),
                );
                await mw.middleware()(ctx, next);
                assertEquals(i, 3);
                assertSpyCalls(read, 2);
                assertSpyCall(read, 1, { args: [ctx] });
                assertSpyCalls(write, 2);
                assertEquals(write.calls[1].args[0], ctx);
                assertEquals(write.calls[1].args[1].state.convo.length, 2);
                assertSpyCalls(del, 0);

                mw = new Composer<TestContext>(plugin, convo);
                ctx = mkctx();
                await mw.middleware()(ctx, next);
                ctx = mkctx();
                await mw.middleware()(ctx, next);

                assertEquals(
                    res,
                    targets.filter((x) => x !== targets[targetIndex]),
                );
                assertSpyCalls(onEnter, 3);
                assertSpyCall(onEnter, 0, { args: ["convo"] });
                assertSpyCall(onEnter, 1, { args: ["convo"] });
                assertSpyCall(onEnter, 2, { args: ["convo"] });
                assertSpyCalls(onExit, 1);
                assertSpyCall(onExit, 0, { args: ["convo"] });
            });
        }
        it("should support exiting a conversation while entering it", async () => {
            const ctx = mkctx();
            let state: VersionedState<ConversationData> = versionify({});
            const read = spy((_ctx: Context) => state);
            const write = spy(
                (_ctx: Context, data: VersionedState<ConversationData>) => {
                    state = data;
                },
            );
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                async (ctx) => {
                    await Promise.allSettled([
                        ctx.conversation.enter("convo"),
                        ctx.conversation.exit("convo"),
                    ]);
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 0);
        });
        it("should prevent installing the conversations plugin recursively", async () => {
            const ctx = mkctx();
            const read = spy((): VersionedState<ConversationData> =>
                versionify({})
            );
            const write = spy(
                (_ctx: Context, _state: VersionedState<ConversationData>) => {},
            );
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    storage: {
                        type: "context",
                        adapter: { read, write, delete: del },
                    },
                }),
                createConversation(
                    async (_c, ctx: ConversationFlavor<Context>) => {
                        await assertRejects(async () => {
                            const recursive = conversations();
                            await recursive(ctx, () => Promise.resolve());
                        });
                        i++;
                    },
                    "convo",
                ),
                (ctx) => ctx.conversation.enter("convo"),
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
            assertSpyCalls(read, 1);
            assertSpyCall(read, 0, { args: [ctx] });
            assertSpyCalls(write, 0);
            assertSpyCalls(del, 0);
        });
    });
    it("should support resuming conversations", async () => {
        let mw = new Composer<TestContext>();
        const plugin = conversations();
        let p = 0;
        let q = 0;
        let r = 0;
        let s = 0;
        const convo = createConversation(async (c) => {
            p++;
            await c.wait();
            q++;
        }, { id: "convo", parallel: true });
        const other = createConversation(async (c) => {
            r++;
            await c.wait();
            s++;
        }, { id: "other", parallel: true });
        mw.use(plugin, convo, other, async (ctx) => {
            await ctx.conversation.enter("convo");
            await ctx.conversation.enter("other");
            await ctx.conversation.enter("other");
        });
        await mw.middleware()(mkctx(), next);
        assertEquals([p, q, r, s], [1, 0, 2, 0]);

        for (
            const expected of [
                [2, 1, 2, 0],
                [2, 1, 3, 1],
                [2, 1, 4, 2],
                [2, 1, 4, 2],
            ]
        ) {
            mw = new Composer<TestContext>();
            mw.use(plugin, convo, other);
            await mw.middleware()(mkctx(), next);
            assertEquals([p, q, r, s], expected);
        }
    });
    it("should support handling errors after resuming", async () => {
        const mw = new Composer<TestContext>();
        const plugin = conversations();
        let i = 0;
        let j = 0;
        const err = new Error("come at me bro");
        const convo = createConversation(async (c) => {
            i++;
            await c.wait();
            j++;
            throw err;
        }, "convo");
        mw.use(plugin, convo, (ctx) => ctx.conversation.enter("convo"));
        await mw.middleware()(mkctx(), next);
        await assertRejects(() =>
            Promise.resolve(mw.middleware()(mkctx(), next))
        );
        assertEquals(i, 2);
        assertEquals(j, 1);
    });
    it("should support exiting after resuming", async () => {
        let mw = new Composer<TestContext>();
        const plugin = conversations();
        let i = 0;
        let j = 0;
        const convo = createConversation(async (c) => {
            i++;
            await c.wait();
            j++;
            await c.wait();
            throw new Error("never");
        }, "convo");
        mw.use(plugin, convo, (ctx) => ctx.conversation.enter("convo"));
        await mw.middleware()(mkctx(), next); // enter
        await mw.middleware()(mkctx(), next); // resume
        mw = new Composer<TestContext>();
        mw.use(plugin, (ctx) => ctx.conversation.exitAll());
        await mw.middleware()(mkctx(), next); // exit
        mw = new Composer<TestContext>();
        mw.use(plugin, convo);
        await mw.middleware()(mkctx(), next); // run without error

        assertEquals(i, 2);
        assertEquals(j, 1);
    });
    it("should support skipping after resuming", async () => {
        let mw = new Composer<TestContext>();
        const plugin = conversations();
        let i = 0;
        let j = 0;
        let k = 0;
        const convo = createConversation(async (c) => {
            i++;
            await c.wait();
            j++;
            await c.skip({ next: true });
        }, "convo");
        mw.use(plugin, convo, (ctx) => ctx.conversation.enter("convo"));
        await mw.middleware()(mkctx(), next); // enter
        mw = new Composer<TestContext>();
        mw.use(plugin, convo, () => k++);
        await mw.middleware()(mkctx(), next); // resume and skip
        assertEquals(i, 2);
        assertEquals(j, 1);
        assertEquals(k, 1);
    });
    it("should support skipping after resuming", async () => {
        let mw = new Composer<TestContext>();
        const plugin = conversations();
        let i = 0;
        let j = 0;
        let k = 0;
        const convo = createConversation(async (c) => {
            i++;
            await c.wait();
            j++;
            await c.halt();
            k++;
        }, "convo");
        mw.use(plugin, convo, (ctx) => ctx.conversation.enter("convo"));
        await mw.middleware()(mkctx(), next); // enter
        mw = new Composer<TestContext>();
        mw.use(plugin, convo, () => k++);
        await mw.middleware()(mkctx(), next); // resume and halt
        assertEquals(i, 2);
        assertEquals(j, 1);
        assertEquals(k, 0);
    });
    it("should support checkpoints", async () => {
        const mw = new Composer<TestContext>();
        const plugin = conversations();
        let i = 0;
        let j = 0;
        const convo = createConversation(async (c) => {
            j++;
            await c.external(() => i++);
            const check = c.checkpoint();
            await c.external(() => i++);
            if (j === 1) {
                await c.rewind(check);
                i = -1; // never
            }
            await c.external(() => i++);
        }, "convo");
        mw.use(plugin, convo, (ctx) => ctx.conversation.enter("convo"));
        await mw.middleware()(mkctx(), next);
        assertEquals(i, 4);
        assertEquals(j, 2);
    });
});

describe("enterConversation and resumeConversation", () => {
    it("should work", async () => {
        const expected = mkctx();
        let i = 0;
        const convo: ConversationBuilder<Context, Context> = async (
            conversation,
            _ctx,
            param: string,
        ) => {
            assertEquals(param, "input");
            const ctx = await conversation.wait();
            assertNotStrictEquals(ctx, expected);
            assertStrictEquals(ctx.update, expected.update);
            i++;
        };
        const first = await enterConversation(convo, mkctx(), {
            args: ["input"],
        });
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const second = await resumeConversation(convo, expected, first);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
});
