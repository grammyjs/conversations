// deno-lint-ignore-file no-explicit-any
import d from "https://cdn.skypack.dev/debug@4.3.4";
// For some strange reason the debug module always prints logs???
d.log = () => {};

import {
    type Conversation,
    type ConversationFlavor,
    conversations,
    createConversation,
} from "../src/conversation.ts";
import {
    ApiResponse,
    Bot,
    type Chat,
    Composer,
    type Context,
    type Middleware,
    type RawApi,
    session,
    type Update,
    type User,
} from "../src/deps.deno.ts";

type MyContext = Context & ConversationFlavor;
export const message_id = 42;
export const chat: Chat.PrivateChat = {
    type: "private",
    id: 1337,
    first_name: "Convo",
    last_name: "Boi",
    username: "mr_convo_boi_69",
};
export const from: User = {
    id: 42,
    first_name: "Bob",
    is_bot: false,
};
export const date = Math.trunc(Date.now() / 1000);
export const slashStart: Update = {
    update_id: 14,
    message: {
        message_id: message_id - 1,
        chat,
        from,
        date,
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: "/start".length }],
    },
};

interface ApiCall<M extends keyof RawApi = keyof RawApi> {
    method: M;
    result: Awaited<ReturnType<RawApi[M]>> | ApiResponse<ApiCall>;
}

export async function testConversation<T>(
    builder: (conversation: Conversation<MyContext>, ctx: MyContext) => T,
    update: Update | Update[] = [],
    result: ApiCall | ApiCall[] = [],
    mw: Middleware<MyContext> = new Composer(),
): Promise<T | undefined> {
    const updates = Array.isArray(update) ? update : [update];
    const results = Array.isArray(result) ? result.reverse() : [result];
    const bot = new Bot<MyContext>("dummy", {
        botInfo: {
            id: 17,
            first_name: "Botty",
            is_bot: true,
            username: "bottybot",
            can_join_groups: true,
            can_read_all_group_messages: true,
            supports_inline_queries: true,
        },
    });
    bot.api.config.use((_prev, method) => {
        const { result } = results.splice(
            results.findIndex((res) => res.method === method),
            1,
        )[0];
        return Promise.resolve(
            typeof result === "object" && result !== null && "ok" in result
                ? result
                : { ok: true, result: result as any },
        );
    });
    bot.use(mw);

    let t: T | undefined = undefined;
    async function wrapper(
        conversation: Conversation<MyContext>,
        ctx: MyContext,
    ) {
        t = await builder(conversation, ctx);
    }

    bot.use(
        session({ initial: () => ({}) }),
        conversations(),
        createConversation(wrapper),
    );

    bot.command("start", (ctx) => ctx.conversation.enter("wrapper"));
    await bot.handleUpdate(slashStart);

    for (const update of updates) {
        await bot.handleUpdate(update);
    }

    return t;
}
