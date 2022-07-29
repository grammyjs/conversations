import { type Context } from "./deps.deno.ts";

export type ConversationForm<C extends Context> = Form<C>;
export class Form<C extends Context> {
    constructor(
        private readonly conversation: {
            wait: () => Promise<C>;
            skip: () => Promise<never>;
        },
    ) {}

    async text(otherwise?: (ctx: C) => unknown | Promise<unknown>) {
        const ctx = await this.conversation.wait();
        const text = ctx.msg?.text ?? ctx.msg?.caption;
        if (text === undefined) {
            await otherwise?.(ctx);
            return await this.conversation.skip();
        }
        return text;
    }

    async number(otherwise?: (ctx: C) => unknown | Promise<unknown>) {
        const ctx = await this.conversation.wait();
        const num = parseFloat(ctx.msg?.text ?? ctx.msg?.caption ?? "NaN");
        if (isNaN(num)) {
            await otherwise?.(ctx);
            return await this.conversation.skip();
        }
        return num;
    }

    async int(
        options:
            | number
            | ((ctx: C) => Promise<unknown> | unknown)
            | {
                radix?: number;
                otherwise?: (ctx: C) => Promise<unknown> | unknown;
            },
    ) {
        const { otherwise, radix } = typeof options === "number"
            ? { radix: options, otherwise: undefined }
            : typeof options === "function"
            ? { radix: undefined, otherwise: options }
            : options;
        const ctx = await this.conversation.wait();
        const text = ctx.msg?.text ?? ctx.msg?.caption ?? "NaN";
        const num = parseInt(text, radix);
        if (isNaN(num)) {
            await otherwise?.(ctx);
            return await this.conversation.skip();
        }
        return num;
    }

    async select<T extends string>(
        options: T[],
        otherwise: (ctx: C) => Promise<unknown> | unknown,
    ) {
        const opts: string[] = options;
        const ctx = await this.conversation.wait();
        const text = ctx.msg?.text ?? ctx.msg?.caption;
        if (text === undefined || !opts.includes(text)) {
            await otherwise?.(ctx);
            return await this.conversation.skip();
        }
        return text as T;
    }
}
