import { type Conversation } from "../src/conversation.ts";
import {
    Api,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import { enterConversation, resumeConversation } from "../src/plugin.ts";
import {
    assert,
    assertEquals,
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
        const expected = mkctx();
        let i = 0;
        async function convo(conversation: Convo) {
            conversation.wait().then(() => {
                conversation.wait().then(() => i++);
            });
            await conversation.wait();
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
        assertEquals(third.status, "handled");
        assert(third.status === "handled");
        const thirdCopy = { ...structuredClone(third), args: first.args };
        const fourth = await resumeConversation(convo, expected, thirdCopy);
        assert(fourth.status === "complete");
        assertEquals(i, 1);
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
        const expected = mkctx();
        let i = 0;
        let rnd = 0;
        async function convo(conversation: Convo) {
            const x = await conversation.external(() => Math.random());
            rnd = x;
            await conversation.wait();
            assertEquals(rnd, x);
            i++;
        }
        const first = await enterConversation(convo, expected);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, expected, copy);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
    it("should support external with custom serialisation formats", async () => {
        const expected = mkctx();
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
        const first = await enterConversation(convo, expected);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, expected, copy);
        assertEquals(second.status, "complete");
        assert(second.status === "complete");
        assertEquals(i, 1);
    });
    it("should support external with custom error formats", async () => {
        const expected = mkctx();
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
        const first = await enterConversation(convo, expected);
        assertEquals(first.status, "handled");
        assert(first.status === "handled");
        const copy = structuredClone(first);
        const second = await resumeConversation(convo, expected, copy);
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

        async function convo(conversation: Convo, ctx: Context) {
            const p = conversation.wait(); // 0
            console.log("after first wait");
            ctx = await conversation.wait(); // 1
            // deno-lint-ignore no-explicit-any
            ctx.reply((ctx.update as any).one);
            const [l, r] = await p.then(async (res) => {
                const c = await conversation.wait(); // 2-4
                if ("no" in c.update) await conversation.skip(); // 3-4
                ctx.reply("go").then(() =>
                    // deno-lint-ignore no-explicit-any
                    ctx.reply((res.update as any).deferred)
                );
                return Promise.all([conversation.wait(), conversation.wait()]); // 5, 6-7
            });
            if ("no" in ctx.update) {
                conversation.skip(); // 6
                // deno-lint-ignore no-explicit-any
                ctx.reply((l.update as any).two);
                // deno-lint-ignore no-explicit-any
                await ctx.reply((r.update as any).three);
                await conversation.wait(); // never resolves due to skip
            }
            conversation.halt();
            ctx.reply("done");
            conversation.skip();
        }

        // 0
        console.log(0);
        const first = await enterConversation(convo, mkctx({ deferred: "L8" }));
        assert(first.status === "handled");
        const args = first.args;
        // 1
        console.log(1);
        const second = await resumeConversation(
            convo,
            mkctx({ one: "way" }),
            first,
        );
        assert(second.status === "handled");
        // 2
        console.log(2);
        const third = await resumeConversation(
            convo,
            mkctx({ no: true }),
            first,
        );
        assert(third.status === "skipped");
        // 3
        console.log(3);
        const fourth = await resumeConversation(
            convo,
            mkctx({ no: true }),
            first,
        );
        assert(fourth.status === "skipped");
        // 4
        console.log(4);
        const fifth = await resumeConversation(
            convo,
            mkctx(),
            { ...second, args },
        );
        assert(fifth.status === "handled");
        // 5
        console.log(5);
        const sixth = await resumeConversation(
            convo,
            mkctx({ two: "fold" }),
            { ...fifth, args },
        );
        assert(sixth.status === "handled");
        // 6
        console.log(6);
        const seventh = await resumeConversation(
            convo,
            mkctx({ three: "dimensional" }),
            { ...sixth, args },
        );
        assert(seventh.status === "skipped");
        const eighth = await resumeConversation(
            convo,
            mkctx(),
            { ...sixth, args },
        );
        assert(eighth.status === "skipped");

        assertEquals(methods, Array(6).fill("sendMessage"));
        assertEquals(payloads, []);
    });

    // TODO: concurrent external
    // TODO: common cases such as loops with side-effects
});
