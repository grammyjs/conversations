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
    describe,
    it,
    stub,
} from "./deps.test.ts";

type Convo = Conversation<Context>;
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
            if ("no" in ctx.update) await conversation.skip();
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
    it("should support external with custom serialisation formats", async () => {
        const ctx = mkctx();
        let i = 0;
        async function convo(conversation: Convo) {
            const x = await conversation.external({
                task: (key: string) => new Map([[key, Math.random()]]),
                args: ["rnd"],
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
            name = "errands";
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
    it("should wait for async waterfalls after skip calls for actions", async () => {
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

    // TODO: concurrent external
    // TODO: common cases such as loops with side-effects
});
