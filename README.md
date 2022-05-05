# <h1 align="center">grammY Conversations</h1>

---

**WARNING: unstable.** This is still a very early draft.

Here is an example of how you can use this package. It mainly exports `Conversation` and `ConversationFlavor`.

```ts
import { Bot, Context, session } from "grammy";
import {
    type Conversation,
    type ConversationFlavor,
    createConversation,
} from "@grammyjs/conversations";

type MyContext = ConversationFlavor<Context>;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>("");

async function conversation(t: MyConversation, ctx: MyContext) {
    await captcha(t, ctx);
    await ctx.reply("Send a text message!");
    ctx = await t.wait();
    if (!ctx.message?.text) {
        await ctx.reply("You failed. Bye.");
        return;
    }
    const text0 = ctx.message.text;
    do {
        await ctx.reply("Send another text message!");
        ctx = await t.wait();
    } while (!ctx.message?.text);
    const text1 = ctx.message.text;
    await ctx.reply(`You first wrote ${text0} and then ${text1}`);
    await ctx.reply("Thanks for participating!");
}

async function captcha(t: MyConversation, ctx: MyContext) {
    await ctx.reply("Prove you are human! What is the answer to everything?");
    ctx = await t.wait();
    while (ctx.message?.text !== "42") {
        await ctx.reply("It does not look like you are human, try again!");
        ctx = await t.wait();
    }
    await ctx.reply("Humanity saved, you may pass!");
}

bot.use(session({ initial: () => ({}) }));
bot.use(createConversation(conversation));

bot.command("start", (ctx) => ctx.reply("Hi! Send /enter"));
bot.command("enter", async (ctx) => {
    await ctx.reply("Entering conversation!");
    ctx.conversation.enter("conversation"); // enter the function "conversation" you declared
});

bot.start();
```
