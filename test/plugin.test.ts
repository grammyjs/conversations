import {
    Api,
    Composer,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import {
    type ConversationContext,
    type ConversationData,
    conversations,
    createConversation,
} from "../src/plugin.ts";
import { resolver } from "../src/resolve.ts";
import {
    assertEquals,
    assertInstanceOf,
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
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({ read, write, delete: del }),
            createConversation(() => {}, "convo"),
        );
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
        const read = spy((): ConversationData => ({ convo: [] }));
        const write = spy(() => {});
        const del = spy(() => {});
        const mw = new Composer<TestContext>();
        mw.use(
            conversations({ read, write, delete: del }),
            createConversation(() => {}, "convo"),
        );
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
                createConversation(async (c, ctx, arg0, arg1, arg2) => {
                    assertInstanceOf(ctx, Context);
                    assertEquals(arg0, -1);
                    assertEquals(arg1, "str");
                    assertEquals(arg2, { prop: [] });
                    i++;
                    await c.wait();
                }, "convo"),
                (ctx) =>
                    ctx.conversation.enter("convo", {
                        args: [-1, "str", { prop: [] }],
                    }),
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
            assertSpyCalls(del, 0);
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
            assertSpyCalls(del, 0);
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
        it("should support entering and resuming conversations", async () => {
            let ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            let state: ConversationData = {};
            const read = spy((_ctx: Context) => state);
            const write = spy((_ctx: Context, data: ConversationData) => {
                state = data;
            });
            const del = spy((_ctx: Context) => {});
            const mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            mw.use(
                conversations({ read, write, delete: del }),
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
            assertEquals(write.calls[0].args[1].convo.length, 1);
            assertSpyCalls(del, 0);
            ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
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
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const mw = new Composer<TestContext>();
            let i = 0;
            mw.use(
                conversations({
                    read: () => ({}),
                    write: () => {},
                    delete: () => {},
                }),
                (ctx) => {
                    assertEquals(ctx.conversation.active("nope"), 0);
                    assertEquals(ctx.conversation.active(), {});
                    i++;
                },
            );
            await mw.middleware()(ctx, next);
            assertEquals(i, 1);
        });
        it("should support inspecting active conversations", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});
            const mw = new Composer<TestContext>();
            let j = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    await c.wait();
                }, "convo"),
                createConversation(async (c) => {
                    await c.wait();
                }, "other"),
                async (ctx) => {
                    const len = 3;
                    for (let i = 0; i < len; i++) {
                        await ctx.conversation.enter("convo", {
                            parallel: true,
                        });
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
            await mw.middleware()(ctx, next);
            assertEquals(j, 1);
        });
        it("should throw when entering conversations after middleware is done", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const mw = new Composer<TestContext>();

            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});

            let i = 0;
            const outer = resolver();
            let p: Promise<unknown>;

            mw.use(
                conversations({ read, write, delete: del }),
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
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const mw = new Composer<TestContext>();

            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});

            let i = 0;
            let p: Promise<unknown> | undefined;
            mw.use(
                conversations({ read, write, delete: del }),
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
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const mw = new Composer<TestContext>();

            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});

            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
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
            assertEquals(write.calls[0].args[1].convo.length, 1); // only stored first one
            assertSpyCalls(del, 0);
        });
        it("should support entering concurrently with parallel", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            const mw = new Composer<TestContext>();

            const read = spy((): ConversationData => ({}));
            const write = spy((_ctx: Context, _state: ConversationData) => {});
            const del = spy(() => {});

            let i = 0;
            mw.use(
                conversations({ read, write, delete: del }),
                createConversation(async (c) => {
                    i++;
                    await c.wait();
                }, "convo"),
                async (ctx) => {
                    const [c0, c1] = await Promise.allSettled([
                        ctx.conversation.enter("convo"),
                        ctx.conversation.enter("convo", { parallel: true }),
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
            assertEquals(write.calls[0].args[1].convo.length, 2); // only stored first one
            assertSpyCalls(del, 0);
        });
        it("should support entering and immediately exiting conversations", async () => {
            const ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            let state: ConversationData = {};
            const read = spy((_ctx: Context) => state);
            const write = spy((_ctx: Context, data: ConversationData) => {
                state = data;
            });
            const del = spy((_ctx: Context) => {});
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
            let ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            let state: ConversationData = {};
            const read = spy((_ctx: Context) => state);
            const write = spy((_ctx: Context, data: ConversationData) => {
                state = data;
            });
            const del = spy((_ctx: Context) => {});
            let mw = new Composer<TestContext>();
            let i = 0;
            const plugin = conversations({ read, write, delete: del });
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
            assertEquals(write.calls[0].args[1].convo.length, 1);
            assertSpyCalls(del, 0);

            ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
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
            let ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
            let state: ConversationData = {};
            const read = spy((_ctx: Context) => state);
            const write = spy((_ctx: Context, data: ConversationData) => {
                state = data;
            });
            const del = spy((_ctx: Context) => {});
            let mw = new Composer<TestContext>();
            let i = 0;
            let j = 0;
            const plugin = conversations({ read, write, delete: del });
            mw.use(
                plugin,
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
                    await ctx.conversation.enter("convo", { parallel: true });
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
            assertEquals(write.calls[0].args[1].convo.length, 2);
            assertEquals(write.calls[0].args[1].other.length, 1);
            assertSpyCalls(del, 0);

            ctx = new Context(
                {} as Update,
                new Api("dummy"),
                {} as UserFromGetMe,
            ) as TestContext;
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
                let ctx = new Context(
                    {} as Update,
                    new Api("dummy"),
                    {} as UserFromGetMe,
                ) as TestContext;
                let state: ConversationData = {};
                const read = spy((_ctx: Context) => state);
                const write = spy((_ctx: Context, data: ConversationData) => {
                    state = data;
                });
                const del = spy((_ctx: Context) => {});
                const onEnter = spy(() => {});
                const onExit = spy(() => {});
                let mw = new Composer<TestContext>();
                let i = 0;
                const res: string[] = [];
                const plugin = conversations({
                    read,
                    write,
                    delete: del,
                    onEnter,
                    onExit,
                });
                const convo = createConversation(async (c, _, id: string) => {
                    i++;
                    await c.wait();
                    res.push(id);
                }, "convo");
                mw.use(
                    plugin,
                    convo,
                    async (ctx) => {
                        for (const target of targets) {
                            await ctx.conversation.enter("convo", {
                                args: [target],
                                parallel: true,
                            });
                        }
                    },
                );
                await mw.middleware()(ctx, next);
                assertEquals(i, 3);
                assertSpyCalls(read, 1);
                assertSpyCall(read, 0, { args: [ctx] });
                assertSpyCalls(write, 1);
                assertEquals(write.calls[0].args[0], ctx);
                assertEquals(write.calls[0].args[1].convo.length, 3);
                assertSpyCalls(del, 0);

                ctx = new Context(
                    {} as Update,
                    new Api("dummy"),
                    {} as UserFromGetMe,
                ) as TestContext;
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
                assertEquals(write.calls[1].args[1].convo.length, 2);
                assertSpyCalls(del, 0);

                ctx = new Context(
                    {} as Update,
                    new Api("dummy"),
                    {} as UserFromGetMe,
                ) as TestContext;
                mw = new Composer<TestContext>(plugin, convo);
                await mw.middleware()(ctx, next);

                ctx = new Context(
                    {} as Update,
                    new Api("dummy"),
                    {} as UserFromGetMe,
                ) as TestContext;
                mw = new Composer<TestContext>(plugin, convo);
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
        it("should prevent installing the conversations plugin recursively", async () => {
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
                createConversation(
                    async (_c, ctx: ConversationContext<Context>) => {
                        await assertRejects(async () => {
                            const recursive = conversations({
                                read: () => ({}),
                                write: () => {},
                                delete: () => {},
                            });
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
        // TODO: concurrent enter and exit
    });
    // TODO: resume without parallel
    // TODO: resume with parallel
    // TODO: resume and handle error
    // TODO: resume and exit
    // TODO: resume and skip
    // TODO: resume and halt
    // TODO: do not touch conversations with a different name
});
