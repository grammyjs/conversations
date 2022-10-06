# <h1 align="center">grammY Conversations</h1>

---

The grammY conversations plugin lets you create powerful conversational interfaces with ease.

Here is a quickstart for you, but the real docs are on this page: <https://grammy.dev/plugins/conversations>

## Quickstart

Run `npm i grammy @grammyjs/conversations` and paste the following code:

```ts
import { Bot, type Context, session } from "grammy";
import {
    type Conversation,
    type ConversationFlavor,
    conversations,
    createConversation,
} from "@grammyjs/conversations";

type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>("");

/** Defines the conversation */
async function greeting(conversation: MyConversation, ctx: MyContext) {
    await ctx.reply("Hi there! What is your name?");
    const { message } = await conversation.wait();
    await ctx.reply(`Welcome to the chat, ${message.text}!`);
}

bot.use(session({ initial: () => ({}) }));
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
