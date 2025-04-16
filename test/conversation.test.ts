import { type Conversation } from "../src/conversation.ts";
import {
    Api,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import { enterConversation, resumeConversation } from "../src/plugin.ts";
import { resolver } from "../src/resolve.ts";
import {
    assert,
    assertEquals,
    assertFalse,
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
    stub,
} from "./deps.test.ts";

type Convo = Conversation<Context, Context>;
function mkctx(update: unknown = {}) {
    return new Context(update as Update, new Api("dummy"), {} as UserFromGetMe);
}

describe("Conversation", () => {
    it("should wait", async () => {
        const expected = mkctx();
        let i = 0;
        async function convo(conversation: Convo, ctx: Context) {
            assertNotStrictEquals(ctx, expected);
            assertEquals(ctx.update, expected.update);
            ctx = await conversation.wait();
            assertNotStrictEquals(ctx, expected);
            assertEquals(ctx.update, expected.update);
            ctx = await conversation.wait();
            assertNotStrictEquals(ctx, expected);
            assertEquals(ctx.update, expected.update);
            i++;
        }
        const first = await enterConversation(convo, expected);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, expected, copy);
        assertEquals(second.status, "handled");
        assert(second.status === "handled");
        const otherCopy = { ...structuredClone(second), args: first.args };
        const third = await resumeConversation(convo, expected, otherCopy);
        assertEquals(third.status, "complete");
        assert(third.status === "complete");
        assertEquals(i, 1);
    });
    it("should wait concurrently", async () => {
        const ctx = mkctx();
        let i = 0;
        async function convo(conversation: Convo) {
            conversation.wait().then(() => {
                // floating
                conversation.wait().then(() => {
                    // floating
                    conversation.external(() => i++);
                });
            });
            await conversation.wait().then(() =>
                conversation.wait().then(() => conversation.external(() => i++))
            );
        }
        const first = await enterConversation(convo, ctx);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, ctx, copy);
        assertEquals(second.status, "handled");
        assert(second.status === "handled");
        const otherCopy = { ...structuredClone(second), args: first.args };
        const third = await resumeConversation(convo, ctx, otherCopy);
        assertEquals(third.status, "handled");
        assert(third.status === "handled");
        const thirdCopy = { ...structuredClone(third), args: first.args };
        const fourth = await resumeConversation(convo, ctx, thirdCopy);
        assertEquals(fourth.status, "handled");
        assert(fourth.status === "handled");
        const fourthCopy = { ...structuredClone(fourth), args: first.args };
        const fifth = await resumeConversation(convo, ctx, fourthCopy);
        assertEquals(fifth.status, "complete");
        assert(fifth.status === "complete");
        assertEquals(i, 2);
    });
    it("should skip", async () => {
        let i = 0;
        let j = 0;
        async function convo(conversation: Convo, ctx: Context) {
            i++;
            if ("no" in ctx.update) await conversation.skip({ next: true });
            ctx = await conversation.wait();
            if ("no" in ctx.update) await conversation.skip();
            j++;
        }
        const no = mkctx({ no: true });
        const yes = mkctx();
        const first = await enterConversation(convo, no);
        assert(first.status === "skipped");
        const second = await enterConversation(convo, yes);
        assert(second.status === "handled");
        const third = await resumeConversation(convo, no, second);
        assert(third.status === "skipped");
        assertEquals(j, 0);
        const fourth = await resumeConversation(convo, yes, second);
        assert(fourth.status === "complete");
        assertEquals(i, 4);
        assertEquals(j, 1);
    });
    it("should halt", async () => {
        let i = 0;
        let j = 0;
        let k = 0;
        async function convo(conversation: Convo, ctx: Context) {
            i++;
            if ("halt" in ctx.update) await conversation.halt();
            await conversation.wait();
            j++;
            await conversation.halt();
            k++;
        }
        const halt = mkctx({ halt: true });
        const first = await enterConversation(convo, halt);
        assert(first.status === "complete");
        const second = await enterConversation(convo, mkctx());
        assert(second.status === "handled");
        const third = await resumeConversation(convo, halt, second);
        assert(third.status === "complete");
        assertEquals(i, 3);
        assertEquals(j, 1);
        assertEquals(k, 0);
    });
    it("should support external", async () => {
        const ctx = mkctx();
        let i = 0;
        let rnd = 0;
        async function convo(conversation: Convo) {
            const x = await conversation.external(() => Math.random());
            rnd = x;
            await conversation.wait();
            assertEquals(rnd, x);
            i++;
        }
        const first = await enterConversation(convo, ctx);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, ctx, copy);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
    it("should return immutable data from external", async () => {
        const ctx = mkctx();
        const observe = spy((_counter: number) => {});
        async function convo(conversation: Convo) {
            const pointer = await conversation.external(() => ({ counter: 0 }));
            pointer.counter++;
            const checkoint = conversation.checkpoint();
            observe(pointer.counter);
            await conversation.wait();
            pointer.counter++;
            await conversation.rewind(checkoint);
        }
        const first = await enterConversation(convo, ctx);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const second = await resumeConversation(convo, ctx, first);
        assertEquals(second.status, "handled");
        assert(second.status === "handled");
        assertSpyCalls(observe, 3);
        assertSpyCall(observe, 0, { args: [1] });
        assertSpyCall(observe, 1, { args: [1] });
        assertSpyCall(observe, 2, { args: [1] });
    });
    it("should support outside context objects in external", async () => {
        const ctx = mkctx({ update_id: Math.random() });
        let i = 0;
        let rnd = 0;
        async function convo(conversation: Convo) {
            const x = await conversation.external((outsideContext) => {
                assertStrictEquals(ctx, outsideContext);
                return ctx.update.update_id;
            });
            rnd = x;
            await conversation.wait();
            assertEquals(rnd, x);
            i++;
        }
        const first = await enterConversation(convo, ctx, { ctx });
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, ctx, copy, { ctx });
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(ctx.update, { update_id: rnd });
        assertEquals(i, 1);
    });
    it("should support throw an error when outside context objects are used in external after advancing from an event", async () => {
        const ctx = mkctx({ update_id: Math.random() });
        let i = 0;
        let rnd = 0;
        async function convo(conversation: Convo) {
            const x = await conversation.external((outsideContext) => {
                // deno-lint-ignore no-explicit-any
                const nope = outsideContext as any;
                assertThrows(() => nope());
                assertThrows(() => new nope());
                assertThrows(() =>
                    Object.defineProperty(nope, "key", { value: true })
                );
                assertThrows(() => delete nope.prop);
                assertThrows(() => nope.prop);
                assertThrows(() =>
                    Object.getOwnPropertyDescriptor(nope, "key")
                );
                assertThrows(() => Object.getPrototypeOf(nope));
                assertThrows(() => "key" in nope);
                assertThrows(() => Object.isExtensible(nope));
                assertThrows(() => Reflect.ownKeys(nope));
                assertThrows(() => nope.prop = true);
                assertThrows(() => Object.setPrototypeOf(nope, null));
                return ctx.update.update_id;
            });
            rnd = x;
            await conversation.wait();
            assertEquals(rnd, x);
            i++;
        }
        const first = await enterConversation(convo, ctx, {});
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, ctx, copy, {});
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(ctx.update, { update_id: rnd });
        assertEquals(i, 1);
    });
    it("should support external with custom serialisation formats", async () => {
        const ctx = mkctx();
        let i = 0;
        async function convo(conversation: Convo) {
            const x = await conversation.external({
                task: () => new Map([["rnd", Math.random()]]),
                beforeStore: (map) => Array.from(map.entries()),
                afterLoad: (entries) => new Map(entries),
            });
            await conversation.wait();
            assertInstanceOf(x, Map);
            i++;
        }
        const first = await enterConversation(convo, ctx);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, ctx, copy);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
    it("should support external with custom error formats", async () => {
        const ctx = mkctx();
        let i = 0;
        let j = 0;
        class MyError extends Error {
            override name = "errands";
        }
        async function convo(conversation: Convo) {
            try {
                await conversation.external({
                    task: () => {
                        throw new MyError("meh");
                    },
                    beforeStoreError: (e) =>
                        e instanceof MyError ? e.message : e,
                    afterLoadError: (e) =>
                        typeof e === "string" ? new MyError(e) : e,
                });
                j++;
            } catch (e) {
                assertInstanceOf(e, MyError);
            }
            await conversation.wait();
            i++;
        }
        const first = await enterConversation(convo, ctx);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, ctx, copy);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
        assertEquals(j, 0);
    });
    it("should support concurrent wait/skip/halt/API calls", async () => {
        let i = 0;
        const methods: string[] = [];
        const payloads: unknown[] = [];
        const pattern = new URLPattern({ pathname: "/botdummy/:method" });
        using _ = stub(
            globalThis,
            "fetch",
            (url, opts) => {
                if (typeof url !== "string") throw new Error("bad url");
                const method = pattern.exec(url)?.pathname.groups.method;
                if (method === undefined) throw new Error("bad method");
                const body = opts?.body;
                if (typeof body !== "string") throw new Error("bad body");
                const payload = JSON.parse(body);
                methods.push(method);
                payloads.push(payload);
                return Promise.resolve(
                    new Response(JSON.stringify({ ok: true, result: i++ })),
                );
            },
        );

        async function convo(conversation: Convo, ctx: Context) { // first
            const p = conversation.wait(); // second
            ctx = await conversation.wait(); // third
            // @ts-expect-error mock
            ctx.api.raw.sendMessage0({ one: ctx.update.one });
            const [l, r] = await p.then(async (res) => {
                const c = await conversation.wait(); // fourth, fifth, sixth
                if ("no" in c.update) {
                    await conversation.skip();
                }
                // @ts-expect-error mock
                await ctx.api.raw.sendMessage1({ text: "go" }).then(() =>
                    // @ts-expect-error moc
                    ctx.api.raw.sendMessage2({ deferred: res.update.deferred })
                );
                return Promise.all([
                    conversation.wait(), // seventh
                    conversation.wait(), // eighth, nineth
                ]);
            });
            if ("no" in r.update) {
                // @ts-expect-error mock
                await ctx.api.raw.sendMessage3({ two: l.update.two });
                // @ts-expect-error mock
                await ctx.api.raw.sendMessage4({ three: r.update.three });
                conversation.skip();
                await conversation.wait(); // never resolves due to skip
            }
            // @ts-expect-error mock
            await ctx.api.raw.sendMessage5({ text: "done" });
            conversation.halt();
            conversation.skip();
        }

        const first = await enterConversation(convo, mkctx());
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const args = first.args;
        const second = await resumeConversation(
            convo,
            mkctx({ deferred: "L8" }),
            first,
        );
        assertEquals(second.status, "handled");
        assert(second.status === "handled");
        const third = await resumeConversation(
            convo,
            mkctx({ one: "way" }),
            { ...second, args },
        );
        assertEquals(third.status, "handled");
        assert(third.status === "handled");
        const fourth = await resumeConversation(
            convo,
            mkctx({ no: true }),
            { ...third, args },
        );
        assertEquals(fourth.status, "skipped");
        assert(fourth.status === "skipped");
        const fifth = await resumeConversation(
            convo,
            mkctx({ no: true }),
            { ...third, args },
        );
        assertEquals(fifth.status, "skipped");
        assert(fifth.status === "skipped");
        const sixth = await resumeConversation(
            convo,
            mkctx(),
            { ...third, args },
        );
        assertEquals(sixth.status, "handled");
        assert(sixth.status === "handled");
        const seventh = await resumeConversation(
            convo,
            mkctx({ two: "fold" }),
            { ...sixth, args },
        );
        assertEquals(seventh.status, "handled");
        assert(seventh.status === "handled");
        const eighth = await resumeConversation(
            convo,
            mkctx({ no: true, three: "dimensional" }),
            { ...seventh, args },
        );
        assertEquals(eighth.status, "skipped");
        assert(eighth.status === "skipped");
        const nineth = await resumeConversation(
            convo,
            mkctx(),
            { ...seventh, args },
        );
        assertEquals(nineth.status, "complete");
        assert(nineth.status === "complete");

        assertEquals(i, 6);
        assertEquals(
            methods,
            Array(i).fill("sendMessage").map((m, i) => m + i),
        );
        assertEquals(payloads, [
            { one: "way" },
            { text: "go" },
            { deferred: "L8" },
            { two: "fold" },
            { three: "dimensional" },
            { text: "done" },
        ]);
    });
    it("should wait for async action waterfalls after skip calls", async () => {
        const end = resolver();
        let i = 0;
        let j = 0;
        let macro = false;
        const methods: string[] = [];
        const payloads: unknown[] = [];
        const pattern = new URLPattern({ pathname: "/botdummy/:method" });
        using _ = stub(
            globalThis,
            "fetch",
            (url, opts) => {
                if (typeof url !== "string") throw new Error("bad url");
                const method = pattern.exec(url)?.pathname.groups.method;
                if (method === undefined) throw new Error("bad method");
                const body = opts?.body;
                if (typeof body !== "string") throw new Error("bad body");
                const payload = JSON.parse(body);
                methods.push(method);
                payloads.push(payload);
                return new Promise((resolve) => {
                    // Respond on next macro task
                    setTimeout(() => {
                        const json = JSON.stringify({ ok: true, result: i++ });
                        resolve(new Response(json));
                    }, 0);
                });
            },
        );

        async function convo(conversation: Convo, ctx: Context) { // first, second
            if ("no" in ctx.update) {
                conversation.skip();
                // @ts-expect-error mock
                ctx.api.raw.sendMessage0({ one: ctx.update.one })
                    .then(() =>
                        // @ts-expect-error mock
                        ctx.api.raw.sendMessage1({ two: ctx.update.two })
                            .then(() => j++)
                    );
                await conversation.wait(); // never resolves due to skip
            }
            ctx = await conversation.wait();
            conversation.skip();

            // the conversation builder function should still wait for micro tasks to happen in case
            // @ts-expect-error mock
            ctx.api.raw.sendMessage2({ three: ctx.update.three })
                .then(() =>
                    // @ts-expect-error mock
                    ctx.api.raw.sendMessage3({ four: ctx.update.four })
                        .then(() => j++)
                        .then(() =>
                            setTimeout(() => {
                                // the conversation builder function should
                                // return before the next macro task so `macro`
                                // should still be set to true even though `j`
                                // was incremented etc
                                macro = true;
                                end.resolve();
                            }, 0)
                        )
                );
        }

        const first = await enterConversation(
            convo,
            mkctx({ no: true, one: "way", two: "fold" }),
        );
        assertEquals(first.status, "skipped");
        assert(first.status === "skipped");
        assertEquals(j, 1);
        const second = await enterConversation(convo, mkctx());
        assertEquals(second.status, "handled");
        assert(second.status === "handled");
        const args = second.args;
        const third = await resumeConversation(
            convo,
            mkctx({ three: "dimensional", four: "ier" }),
            { ...second, args },
        );
        assertEquals(third.status, "complete");
        assert(third.status === "complete");
        assertEquals(j, 2);

        assertFalse(macro);
        assertEquals(i, 4);
        assertEquals(methods, [
            "sendMessage0",
            "sendMessage1",
            "sendMessage2",
            "sendMessage3",
        ]);
        assertEquals(payloads, [
            { one: "way" },
            { two: "fold" },
            { three: "dimensional" },
            { four: "ier" },
        ]);
        await end.promise;
    });
    it("should skip concurrent wait calls", async () => {
        let i = 0;
        async function convo(conversation: Convo) {
            const zero = conversation.wait();
            const one = conversation.wait();
            const p0 = zero.then(async ({ update }) => {
                if (update.message?.text !== "zero") {
                    await conversation.skip();
                }
            });
            const p1 = one.then(async ({ update }) => {
                if (update.message?.text !== "one") {
                    await conversation.skip();
                }
                i++;
            });
            await Promise.all([p0, p1]);
            i++;
        }

        const first = await enterConversation(convo, mkctx({ initial: true }));
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const args = first.args;
        const second = await resumeConversation(
            convo,
            mkctx({ message: { text: "one" } }),
            { ...first, args },
        );
        assertEquals(second.status, "handled");
        assert(second.status === "handled");
        const third = await resumeConversation(
            convo,
            mkctx({ message: { text: "zero" } }),
            { ...second, args },
        );
        assertEquals(third.status, "complete");
        assert(third.status === "complete");
        assertEquals(i, 3);
    });
    it("should prevent nested calls to external", async () => {
        const ctx = mkctx();
        let i = 0;
        let j = 0;
        async function convo(conversation: Convo) {
            await conversation.external({
                task: async () => {
                    await assertRejects(() => conversation.external(() => j++));
                    i++;
                },
            });
        }
        const result = await enterConversation(convo, ctx);
        if (result.status !== "complete") console.log(result);
        assertEquals(result.status, "complete");
        assertEquals(i, 1);
        assertEquals(j, 0);
    });
    it("should prevent concurrent calls to external", async () => {
        const ctx = mkctx();
        let i = 0;
        let j = 0;
        async function convo(conversation: Convo) {
            const rsr = resolver();
            const p = conversation.external(() => rsr.promise);
            await assertRejects(() => conversation.external(() => j++));
            rsr.resolve();
            await p;
            i++;
        }
        const result = await enterConversation(convo, ctx);
        if (result.status !== "complete") console.log(result);
        assertEquals(result.status, "complete");
        assertEquals(i, 1);
        assertEquals(j, 0);
    });
    it("should prevent waits calls inside external", async () => {
        const ctx = mkctx();
        let i = 0;
        async function convo(conversation: Convo) {
            await conversation.external({
                task: () => {
                    assertThrows(() => conversation.wait());
                    i++;
                },
            });
        }
        const result = await enterConversation(convo, ctx);
        if (result.status !== "complete") console.log(result);
        assertEquals(result.status, "complete");
        assertEquals(i, 1);
    });
    it("should prevent wait calls concurrent to external", async () => {
        const ctx = mkctx();
        let i = 0;
        async function convo(conversation: Convo) {
            const rsr = resolver();
            const p = conversation.external(() => rsr.promise);
            assertThrows(() => conversation.wait());
            rsr.resolve();
            await p;
            i++;
        }
        const result = await enterConversation(convo, ctx);
        if (result.status !== "complete") console.log(result);
        assertEquals(result.status, "complete");
        assertEquals(i, 1);
    });
    it("should support filtered wait calls", async () => {
        const chat = {
            id: 3,
            type: "private" as const,
            first_name: "dev",
        };
        const from = {
            id: 4,
            first_name: "dev",
            is_bot: false,
        };
        const forward_origin = {
            type: "channel" as const,
            chat: { type: "channel" as const, id: -12, title: "grammY news" },
            date: 1,
            message_id: 31415,
        };
        const enter: Update = {
            update_id: 4,
            message: { message_id: 0, chat, date: Date.now(), from, text: "" },
        };
        const drop: Update = {
            update_id: 1729,
            message: {
                message_id: 42,
                chat,
                date: Date.now(),
                from,
                forward_origin,
                text: "/start",
                entities: [{
                    type: "bot_command",
                    offset: 0,
                    length: "/start".length,
                }],
            },
        };
        const pass: Update = {
            update_id: 1730,
            message: {
                message_id: 43,
                chat,
                date: Date.now(),
                from,
                forward_origin,
                text: "YaY",
                entities: [{ type: "bold", offset: 1, length: 1 }],
            },
        };
        let i = 0;
        let j = 0;
        async function convo(conversation: Convo) {
            const ctx = await conversation.waitFor("message:text")
                .andFor(":forward_origin")
                .unless(Context.has.command("start"), {
                    otherwise: (ctx) => {
                        assertEquals(ctx.update, drop);
                        j++;
                    },
                });
            assertEquals(ctx.update, pass);
            i++;
        }
        const first = await enterConversation(convo, mkctx(enter));
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const args = first.args;
        const state = {
            args,
            replay: first.replay,
            interrupts: first.interrupts,
        };
        let res = await resumeConversation(convo, mkctx(drop), state, {
            parallel: true,
        });
        assertEquals(res.status, "skipped");
        assert(res.status === "skipped");
        res = await resumeConversation(convo, mkctx(pass), state, {
            parallel: true,
        });
        assertEquals(res.status, "complete");
        assert(res.status === "complete");
        assertEquals(i, 1);
        assertEquals(j, 1);
    });
    it("should support loops and functions and more", async () => {
        let j = 0;
        async function convo(conversation: Convo, ctx: Context) {
            let sum = 0;
            assertEquals(ctx.update, 42 as unknown as Update);
            async function waitN(limit: number) {
                for (let i = 0; i < limit; i++) {
                    sum += i;
                    ctx = await conversation.wait();
                    assertEquals(ctx.update, i as unknown as Update);
                    await waitN(i);
                }
            }
            await waitN(4);
            assertEquals(sum, 11);
            j++;
        }
        const first = await enterConversation(convo, mkctx(42));
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const args = first.args;
        let state = {
            args,
            replay: first.replay,
            interrupts: first.interrupts,
        };
        for (const i of [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1]) {
            const res = await resumeConversation(convo, mkctx(i), state);
            if (res.status !== "handled") console.log(res);
            assertEquals(res.status, "handled");
            assert(res.status === "handled");
            state = { args, ...res };
        }
        const res = await resumeConversation(convo, mkctx(0), state);
        assertEquals(res.status, "complete");
        assert(res.status === "complete");
        assertEquals(j, 1);
    });

    it("should support now", async () => {
        let i = 0;
        let old: number | undefined;
        async function convo(conversation: Convo) {
            const cnow = await conversation.now();
            await conversation.external(() => old = cnow);
            await conversation.wait();
            assertEquals(old, cnow);
            i++;
        }
        const first = await enterConversation(convo, mkctx());
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const second = await resumeConversation(convo, mkctx(), first);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
    it("should support random", async () => {
        let i = 0;
        let old: number | undefined;
        async function convo(conversation: Convo) {
            const cnow = await conversation.random();
            await conversation.external(() => old = cnow);
            await conversation.wait();
            assertEquals(old, cnow);
            i++;
        }
        const first = await enterConversation(convo, mkctx());
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const second = await resumeConversation(convo, mkctx(), first);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
    it("should support log", async () => {
        const log = spy((..._: unknown[]) => {});
        using _ = stub(console, "log", log);
        async function convo(conversation: Convo) {
            await conversation.log("foo", 42);
            await conversation.wait();
        }
        const first = await enterConversation(convo, mkctx());
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const second = await resumeConversation(convo, mkctx(), first);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertSpyCalls(log, 1);
        assertSpyCall(log, 0, { args: ["foo", 42] });
    });
    it("should support error", async () => {
        const err = spy((..._: unknown[]) => {});
        using _ = stub(console, "error", err);
        async function convo(conversation: Convo) {
            await conversation.error("foo", 42);
            await conversation.wait();
        }
        const first = await enterConversation(convo, mkctx());
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const second = await resumeConversation(convo, mkctx(), first);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertSpyCalls(err, 1);
        assertSpyCall(err, 0, { args: ["foo", 42] });
    });
});
