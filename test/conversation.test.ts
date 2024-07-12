import { type Conversation } from "../src/conversation.ts";
import {
    Api,
    Context,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import { resumeConversation } from "../src/mod.ts";
import { enterConversation } from "../src/plugin.ts";
import {
    assert,
    assertEquals,
    assertNotStrictEquals,
    describe,
    it,
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
    // TODO: external with plain data
    // TODO: external with custom serialsation for values
    // TODO: external with custom serialsation for errors
    // TODO: concurrent wait/skip/halt/external
    // TODO: common cases such as loops with side-effects, or floating checks
});
