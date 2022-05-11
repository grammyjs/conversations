# <h1 align="center">grammY Conversations</h1>

---

> **WARNING: unstable.** This is not completely stable yet. Please try it out and provide feedback, either by opening an issue or in the [group chat](https://t.me/grammyjs).
> You can also [look at a preview of the docs](https://github.com/grammyjs/website/pull/331).

Here is an example for both Deno and Node of how you can use this package. It mainly exports `Conversation`, `ConversationFlavor`, and `createConversation`.

## Deno

```ts
import {
    Bot,
    Context,
    session,
} from "https://deno.land/x/grammy@v1.8.3/mod.ts";
import {
    type Conversation,
    type ConversationFlavor,
    conversations,
    createConversation,
} from "./src/mod.ts";

type MyContext = Context & ConversationFlavor;
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
    conversation.log(text0);
    do {
        await ctx.reply("Send another text message!");
        ctx = await conversation.wait();
    } while (!ctx.message?.text);
    const text1 = ctx.message.text;
    conversation.log(text1);
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

bot.use(
    session({
        initial: () => ({}),
    }),
);

bot.use(conversations());
bot.use(createConversation(example));

bot.command("enter", async (ctx) => {
    await ctx.reply("Entering conversation!");
    await ctx.conversation.enter("example"); // enter the function "example" you declared
});

bot.command("start", (ctx) => ctx.reply("Hi! Send /enter"));
bot.use((ctx) => ctx.reply("What a nice update."));

bot.start();
```

## Node

```ts
import { Bot, Context, session } from "grammy";
import {
    type Conversation,
    type ConversationFlavor,
    conversations,
    createConversation,
} from "@grammyjs/conversations";

type MyContext = Context & ConversationFlavor;
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
    conversation.log(text0);
    do {
        await ctx.reply("Send another text message!");
        ctx = await conversation.wait();
    } while (!ctx.message?.text);
    const text1 = ctx.message.text;
    conversation.log(text1);
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

bot.use(
    session({
        initial: () => ({}),
    }),
);

bot.use(conversations());
bot.use(createConversation(example));

bot.command("enter", async (ctx) => {
    await ctx.reply("Entering conversation!");
    await ctx.conversation.enter("example"); // enter the function "example" you declared
});

bot.command("start", (ctx) => ctx.reply("Hi! Send /enter"));
bot.use((ctx) => ctx.reply("What a nice update."));

bot.start();
```
