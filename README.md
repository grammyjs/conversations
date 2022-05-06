# <h1 align="center">grammY Conversations</h1>

---

> **WARNING: unstable.** This is not completely stable yet. Please try it out and provide feedback, either by opening an issue or in the [group chat](https://t.me/grammyjs).

Here is an example for both Deno and Node of how you can use this package. It mainly exports `Conversation`, `ConversationFlavor`, and `createConersation`.

## Deno

```ts
import { Bot, Context, session } from "https://deno.land/x/grammy/mod.ts";
import {
    type Conversation,
    type ConversationFlavor,
    createConversation,
} from "https://deno.land/x/grammy_conversations/mod.ts";

type MyContext = ConversationFlavor<Context>;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>("");

async function example(conversation: MyConversation, ctx: MyContext) {
    await captcha(conversation, ctx);
    await ctx.reply("Send a text message!");
    ctx = await conversation.wait();
    if (!ctx.message?.text) {
        await ctx.reply("You failed. Bye.");
        return;
    }
    const text0 = ctx.message.text;
    do {
        await ctx.reply("Send another text message!");
        ctx = await conversation.wait();
    } while (!ctx.message?.text);
    const text1 = ctx.message.text;
    await ctx.reply(`You first wrote ${text0} and then ${text1}`);
    await ctx.reply("Thanks for participating!");
}

async function captcha(conversation: MyConversation, ctx: MyContext) {
    await ctx.reply("Prove you are human! What is the answer to everything?");
    ctx = await conversation.wait();
    while (ctx.message?.text !== "42") {
        await ctx.reply("It does not look like you are human, try again!");
        ctx = await conversation.wait();
    }
    await ctx.reply("Humanity saved, you may pass!");
}

bot.use(session({ initial: () => ({}) }));
bot.use(createConversation(conversation));

bot.command("start", (ctx) => ctx.reply("Hi! Send /enter"));
bot.command("enter", async (ctx) => {
    await ctx.reply("Entering conversation!");
    ctx.conversation.enter("example"); // enter the function "example" you declared
});

bot.start();
```

## Node

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

async function example(conversation: MyConversation, ctx: MyContext) {
    await captcha(conversation, ctx);
    await ctx.reply("Send a text message!");
    ctx = await conversation.wait();
    if (!ctx.message?.text) {
        await ctx.reply("You failed. Bye.");
        return;
    }
    const text0 = ctx.message.text;
    do {
        await ctx.reply("Send another text message!");
        ctx = await conversation.wait();
    } while (!ctx.message?.text);
    const text1 = ctx.message.text;
    await ctx.reply(`You first wrote ${text0} and then ${text1}`);
    await ctx.reply("Thanks for participating!");
}

async function captcha(conversation: MyConversation, ctx: MyContext) {
    await ctx.reply("Prove you are human! What is the answer to everything?");
    ctx = await conversation.wait();
    while (ctx.message?.text !== "42") {
        await ctx.reply("It does not look like you are human, try again!");
        ctx = await conversation.wait();
    }
    await ctx.reply("Humanity saved, you may pass!");
}

bot.use(session({ initial: () => ({}) }));
bot.use(createConversation(conversation));

bot.command("start", (ctx) => ctx.reply("Hi! Send /enter"));
bot.command("enter", async (ctx) => {
    await ctx.reply("Entering conversation!");
    ctx.conversation.enter("example"); // enter the function "example" you declared
});

bot.start();
```
