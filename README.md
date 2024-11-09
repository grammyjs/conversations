# <h1 align="center">grammY conversations</h1>

---

The grammY conversations plugin lets you create powerful conversational interfaces with ease.

This is version 2 of the plugin.
Version 2 is a complete rewrite from scratch.
It is not released yet, but most of the coding is done, so it will likely be released in the coming days or weeks, right after the documentation was written.

That being said, now is the perfect time to try out the rewrite!

Here is a quickstart for you for v2, but if you want to use v1 instead, you should rather look at the actual docs page: <https://grammy.dev/plugins/conversations>

## Quickstart

Run `npm i github:grammyjs/conversations` to install the code right from this repository and paste the following code:

```ts
import { Bot, type Context } from "grammy";
import {
    type Conversation,
    type ConversationFlavor,
    conversations,
    createConversation,
} from "@grammyjs/conversations";

type MyContext = ConversationFlavor<Context>;
type MyConversationContext = Context;

type MyConversation = Conversation<MyContext, MyConversationContext>;

const bot = new Bot<MyContext>("");

/** Defines the conversation */
async function greeting(
    conversation: MyConversation,
    ctx: MyConversationContext,
) {
    await ctx.reply("Hi there! What is your name?");
    const { message } = await conversation.wait();
    await ctx.reply(`Welcome to the chat, ${message.text}!`);
}

bot.use(conversations());
bot.use(createConversation(greeting));

bot.command("enter", async (ctx) => {
    await ctx.reply("Entering conversation!");
    // enter the function "greeting" you declared
    await ctx.conversation.enter("greeting");
});

bot.command("start", (ctx) => ctx.reply("Hi! Send /enter"));
bot.use((ctx) => ctx.reply("What a nice update."));

bot.start();
```

Nifty!
