import {
    Composer,
    type Context,
    type Filter,
    type InlineKeyboardButton,
    type LoginUrl,
    type Middleware,
    type SwitchInlineQueryChosenChat,
} from "./deps.deno.ts";
import { youTouchYouDie } from "./nope.ts";

const b = 0xff; // mask for lowest byte
const toNums = (str: string) => Array.from(str).map((c) => c.codePointAt(0)!);
const dec = new TextDecoder();
/** Efficiently computes a 4-byte hash of an int32 array */
function tinyHash(nums: number[]): string {
    // Same hash as the menu plugin uses
    let hash = 17;
    for (const n of nums) hash = ((hash << 5) + (hash << 2) + hash + n) >>> 0; // hash = 37 * hash + n
    const bytes = [hash >>> 24, (hash >> 16) & b, (hash >> 8) & b, hash & b];
    return dec.decode(Uint8Array.from(bytes)); // turn bytes into string
}

const ops = Symbol("conversation menu building operations");
const opts = Symbol("conversation menu building options");

const INJECT_METHODS = new Set([
    "editMessageText",
    "editMessageCaption",
    "editMessageMedia",
    "editMessageReplyMarkup",
    "stopPoll",
]);

export type ButtonHandler<C extends Context> = (
    ctx: C,
) => unknown | Promise<unknown>;

export interface MenuOptions<C extends Context> {
    autoAnswer?: boolean;
    fingerprint?: DynamicString<C>;
}

export class ConversationMenuPool<C extends Context> {
    private index: Map<string, ConversationMenu<C>> = new Map();

    constructor(
        private readonly conversation: {
            wait: (
                opts: { maxMilliseconds?: number; collationKey?: string },
            ) => Promise<C>;
            skip: (opts: { drop?: boolean }) => Promise<never>;
        },
    ) {}

    create(id?: string) {
        if (id === undefined) {
            id = createId(this.index.size);
        } else if (id.includes("/")) {
            throw new Error(
                `You cannot use '/' in a menu identifier ('${id}')`,
            );
        }
        const menu = new ConversationMenu<C>(id);
        this.index.set(id, menu);
        return menu;
    }

    async handle(ctx: C): Promise<{ next: boolean }> {
        // === SETUP RENDERING ===
        /**
         * Renders a conversational menu to a button array.
         *
         * @param id A valid identifier of a conversational menu
         */
        const render = async (id: string) => {
            const self = this.index.get(id);
            if (self === undefined) throw new Error("should never happen");
            const renderer = createRenderer(
                ctx,
                async (btn, i, j): Promise<InlineKeyboardButton> => {
                    const text = await uniform(ctx, btn.text);

                    if ("url" in btn) {
                        let { url, ...rest } = btn;
                        url = await uniform(ctx, btn.url);
                        return { ...rest, url, text };
                    } else if ("middleware" in btn) {
                        const row = i.toString(16);
                        const col = j.toString(16);
                        const payload = await uniform(ctx, btn.payload, "");
                        if (payload.includes("/")) {
                            throw new Error(
                                `Could not render menu '${id}'! Payload must not contain a '/' character but was '${payload}'`,
                            );
                        }
                        return {
                            callback_data: `${id}/${row}/${col}/${payload}/`,
                            text,
                        };
                    } else return { ...btn, text };
                },
            );
            // Render button array
            const rendered = await renderer(self[ops]);
            // Get shape of array
            const lengths = [
                rendered.length,
                ...rendered.map((row) => row.length),
            ];
            // Generate fingerprint
            const fingerprint = await uniform(ctx, self[opts].fingerprint);
            for (const row of rendered) {
                for (const btn of row) {
                    if ("callback_data" in btn) {
                        // Inject hash values to detect keyboard changes
                        let type: "h" | "f";
                        let data: number[];
                        if (fingerprint) {
                            type = "f";
                            data = toNums(fingerprint);
                        } else {
                            type = "h";
                            data = [...lengths, ...toNums(btn.text)];
                        }
                        btn.callback_data += type + tinyHash(data);
                    }
                }
            }
            return rendered;
        };
        /**
         * Replaces all menu instances by their rendered versions inside the
         * given payload object.
         *
         * @param payload The payload to mutate
         */
        const prepare = async (payload: Record<string, unknown>) => {
            if (payload.reply_markup instanceof ConversationMenu) {
                const rendered = await render(payload.reply_markup.id);
                payload.reply_markup = { inline_keyboard: rendered };
            }
        };

        // === HANDLE OUTGOING MENUS ===
        // Install a transformer that watches all outgoing payloads for menus
        ctx.api.config.use(async (prev, method, payload, signal) => {
            const p: Record<string, unknown> = payload;
            if (Array.isArray(p.results)) {
                await Promise.all(p.results.map((r) => prepare(r)));
            } else {
                await prepare(p);
            }
            return await prev(method, payload, signal);
        });

        // === CHECK INCOMING UPDATES ===
        // Parse callback query data and check if this is for us
        if (!ctx.has("callback_query:data")) return { next: true };
        const data = ctx.callbackQuery.data;
        const parsed = parseId(data);
        if (parsed === undefined) return { next: true };
        const { id, parts } = parsed;
        if (parts.length < 4) return { next: true };
        const [rowStr, colStr, payload, ...rest] = parts;
        const [type, ...h] = rest.join("/");
        const hash = h.join("");
        // Skip handling if this is not a known format
        if (!rowStr || !colStr) return { next: true };
        if (type !== "h" && type !== "f") return { next: true };
        // Get identified menu from index
        const menu = this.index.get(id);
        if (menu === undefined) return { next: true };
        const row = parseInt(rowStr, 16);
        const col = parseInt(colStr, 16);
        if (row < 0 || col < 0) {
            const msg = `Invalid button position '${rowStr}/${colStr}'`;
            throw new Error(msg);
        }
        // We now know that the update needs to be handled by `menu`.

        // === HANDLE INCOMING CALLBACK QUERIES ===
        // Provide payload on `ctx.match` if it is not empty
        if (payload) ctx.match = payload;
        // Install `ctx.menu`
        let injectMenu = false;
        let targetMenu: ConversationMenu<C> | undefined = menu;
        ctx.api.config.use((prev, method, payload, signal) => {
            if (
                INJECT_METHODS.has(method) &&
                !("reply_markup" in payload) &&
                "chat_id" in payload &&
                payload.chat_id !== undefined &&
                payload.chat_id === ctx.chat?.id &&
                "message_id" in payload &&
                payload.message_id !== undefined &&
                payload.message_id === ctx.msg?.message_id
            ) {
                injectMenu = false;
                Object.assign(payload, { reply_markup: targetMenu });
            }
            return prev(method, payload, signal);
        });
        async function nav(
            { immediate }: Immediate = {},
            menu?: ConversationMenu<C>,
        ) {
            injectMenu = true;
            targetMenu = menu;
            if (immediate) await ctx.editMessageReplyMarkup();
        }
        const controls: ConversationMenuControlPanel = {
            update: (config) => nav(config, menu),
            close: (config) => nav(config, undefined),
            nav: async (to, config) => {
                const m = this.index.get(to);
                if (m === undefined) {
                    const validIds = Array.from(this.index.keys())
                        .map((k) => `'${k}'`)
                        .join(", ");
                    throw new Error(
                        `Menu '${id}' is not known! Known submenus are: ${validIds}`,
                    );
                }
                await nav(config, m);
            },
            back: (config) => nav(config, undefined /* previous menu */), // TODO: store history in pool
        };
        Object.assign(ctx, { menu: controls });
        // We now have prepared the context for being handled by `menu` so we
        // can actually begin handling the received callback query.
        const mctx = ctx as ConversationMenuContext<C>;
        async function menuIsOutdated() {
            console.error(`conversational menu '${id}' was outdated!`);
            console.error(new Error("trace").stack);
            await Promise.all([
                ctx.answerCallbackQuery(),
                ctx.editMessageReplyMarkup(),
            ]);
        }
        // Check fingerprint if used
        const fingerprint = await uniform(ctx, menu[opts].fingerprint);
        const useFp = fingerprint !== "";
        if (useFp !== (type === "f")) {
            await menuIsOutdated();
            return { next: false };
        }
        if (useFp && tinyHash(toNums(fingerprint)) !== hash) {
            await menuIsOutdated();
            return { next: false };
        }
        // Create renderer and perform rendering
        const renderer = createRenderer(ctx, (btn: MenuButton<C>) => btn);
        const range: RawRange<C> = await renderer(menu[ops]);
        // Check dimension
        if (!useFp && (row >= range.length || col >= range[row].length)) {
            await menuIsOutdated();
            return { next: false };
        }
        // Check correct button type
        const btn = range[row][col];
        if (!("middleware" in btn)) {
            if (!useFp) {
                await menuIsOutdated();
                return { next: false };
            }
            throw new Error(
                `Cannot invoke handlers because menu '${id}' is outdated!`,
            );
        }
        // Check dimensions
        if (!useFp) {
            const rowCount = range.length;
            const rowLengths = range.map((row) => row.length);
            const label = await uniform(ctx, btn.text);
            const data = [rowCount, ...rowLengths, ...toNums(label)];
            const expectedHash = tinyHash(data);
            if (hash !== expectedHash) {
                await menuIsOutdated();
                return { next: false };
            }
        }
        // Run handler
        const c = new Composer<ConversationMenuContext<C>>();
        if (menu[opts].autoAnswer) {
            c.fork((ctx) => ctx.answerCallbackQuery());
        }
        c.use(...btn.middleware);
        let next = false;
        await c.middleware()(mctx, () => {
            next = true;
            return Promise.resolve();
        });
        if (injectMenu) await nav({ immediate: true }, targetMenu);
        return { next };
    }
}

/** Generate short and unique identifier that is considered invalid by all other menu instances */
function createId(size: number) {
    return `//${size.toString(36)}`;
}
function parseId(data: string) {
    if (data.startsWith("//")) {
        const [id, ...parts] = data.substring(2).split("/");
        if (!id || isNaN(parseInt(id, 36))) return undefined;
        return { id: "//" + id, parts };
    } else {
        const [id, ...parts] = data.split("/");
        if (id === undefined) return undefined;
        return { id, parts };
    }
}

export interface ConversationMenuFlavor {
    match?: string;
    menu: ConversationMenuControlPanel;
}
export interface Immediate {
    immediate?: boolean;
}
export interface ConversationMenuControlPanel {
    update(config: { immediate: true }): Promise<void>;
    update(config?: { immediate?: false }): void;
    close(config: { immediate: true }): Promise<void>;
    close(config?: { immediate?: false }): void;
    back(config: { immediate: true }): Promise<void>;
    back(config?: { immediate?: false }): void;
    nav(to: string, config: { immediate: true }): Promise<void>;
    nav(to: string, config?: { immediate?: false }): void;
}
export type ConversationMenuContext<C extends Context> =
    & Filter<C, "callback_query:data">
    & ConversationMenuFlavor;
export type ConversationMenuMiddleware<C extends Context> = Middleware<
    ConversationMenuContext<C>
>;
type MaybePromise<T> = T | Promise<T>;
type DynamicString<C extends Context> = (ctx: C) => MaybePromise<string>;
type MaybeDynamicString<C extends Context> = string | DynamicString<C>;
interface TextAndPayload<C extends Context> {
    text: MaybeDynamicString<C>;
    payload?: MaybeDynamicString<C>;
}
export type MaybePayloadString<C extends Context> =
    | MaybeDynamicString<C>
    | TextAndPayload<C>;
type Cb<C extends Context> =
    & Omit<
        InlineKeyboardButton.CallbackButton,
        "callback_data"
    >
    & {
        middleware: ConversationMenuMiddleware<C>[];
        payload?: MaybeDynamicString<C>;
    };
type NoCb = Exclude<InlineKeyboardButton, InlineKeyboardButton.CallbackButton>;
type RemoveAllTexts<T> = T extends { text: string } ? Omit<T, "text"> : T;
type MakeUrlDynamic<C extends Context, T> = T extends { url: string }
    ? Omit<T, "url"> & { url: MaybeDynamicString<C> }
    : T;
export type MenuButton<C extends Context> = {
    text: MaybeDynamicString<C>;
} & MakeUrlDynamic<C, RemoveAllTexts<NoCb | Cb<C>>>;
type RawRange<C extends Context> = MenuButton<C>[][];
type MaybeRawRange<C extends Context> = ConversationMenuRange<C> | RawRange<C>;
type DynamicRange<C extends Context> = (
    ctx: C,
) => MaybePromise<MaybeRawRange<C>>;
type MaybeDynamicRange<C extends Context> = MaybeRawRange<C> | DynamicRange<C>;
export class ConversationMenuRange<C extends Context> {
    [ops]: MaybeDynamicRange<C>[] = [];
    addRange(...range: MaybeDynamicRange<C>[]) {
        this[ops].push(...range);
        return this;
    }
    add(...btns: MenuButton<C>[]) {
        return this.addRange([btns]);
    }
    row() {
        return this.addRange([[], []]);
    }
    url(text: MaybeDynamicString<C>, url: MaybeDynamicString<C>) {
        return this.add({ text, url });
    }
    text(
        text: MaybeDynamicString<C>,
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    text(
        text: TextAndPayload<C>,
        ...middleware: ConversationMenuMiddleware<C & { match: string }>[]
    ): this;
    text(
        text: MaybePayloadString<C>,
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    text(
        text: MaybePayloadString<C>,
        ...middleware: ConversationMenuMiddleware<C>[]
    ) {
        return this.add(
            typeof text === "object"
                ? { ...text, middleware }
                : { text, middleware },
        );
    }
    webApp(text: MaybeDynamicString<C>, url: string) {
        return this.add({ text, web_app: { url } });
    }
    login(text: MaybeDynamicString<C>, loginUrl: string | LoginUrl) {
        return this.add({
            text,
            login_url: typeof loginUrl === "string"
                ? { url: loginUrl }
                : loginUrl,
        });
    }
    switchInline(text: MaybeDynamicString<C>, query = "") {
        return this.add({ text, switch_inline_query: query });
    }
    switchInlineCurrent(text: MaybeDynamicString<C>, query = "") {
        return this.add({ text, switch_inline_query_current_chat: query });
    }
    switchInlineChosen(
        text: MaybeDynamicString<C>,
        query: SwitchInlineQueryChosenChat = {},
    ) {
        return this.add({ text, switch_inline_query_chosen_chat: query });
    }
    game(text: MaybeDynamicString<C>) {
        return this.add({ text, callback_game: {} });
    }
    pay(text: MaybeDynamicString<C>) {
        return this.add({ text, pay: true });
    }
    submenu(
        text: MaybeDynamicString<C>,
        menu: string,
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    submenu(
        text: TextAndPayload<C>,
        menu: string,
        ...middleware: ConversationMenuMiddleware<C & { match: string }>[]
    ): this;
    submenu(
        text: MaybePayloadString<C>,
        menu: string,
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    submenu(
        text: MaybePayloadString<C>,
        menu: string,
        ...middleware: ConversationMenuMiddleware<C>[]
    ) {
        return this.text(
            text,
            middleware.length === 0
                ? (ctx) => ctx.menu.nav(menu)
                : (ctx, next) => (ctx.menu.nav(menu), next()),
            ...middleware,
        );
    }
    back(
        text: MaybeDynamicString<C>,
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    back(
        text: TextAndPayload<C>,
        ...middleware: ConversationMenuMiddleware<C & { match: string }>[]
    ): this;
    back(
        text: MaybePayloadString<C>,
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    back(
        text: MaybePayloadString<C>,
        ...middleware: ConversationMenuMiddleware<C>[]
    ) {
        return this.text(
            text,
            middleware.length === 0
                ? (ctx) => ctx.menu.back()
                : (ctx, next) => (ctx.menu.back(), next()),
            ...middleware,
        );
    }
    dynamic(
        rangeBuilder: (
            ctx: C,
            range: ConversationMenuRange<C>,
        ) => MaybePromise<MaybeRawRange<C> | void>,
    ) {
        return this.addRange(async (ctx: C) => {
            const range = new ConversationMenuRange<C>();
            const res = await rangeBuilder(ctx, range);
            if (res instanceof ConversationMenu) {
                throw new Error(
                    "Cannot use a `Menu` instance as a dynamic range, did you mean to return an instance of `MenuRange` instead?",
                );
            }
            return res instanceof ConversationMenuRange ? res : range;
        });
    }
    append(range: MaybeRawRange<C>) {
        if (range instanceof ConversationMenuRange) {
            this[ops].push(...range[ops]);
            return this;
        } else return this.addRange(range);
    }
}

export class ConversationMenu<C extends Context>
    extends ConversationMenuRange<C> {
    [opts]: MenuOptions<C>;
    constructor(public readonly id: string, options: MenuOptions<C> = {}) {
        super();
        this[opts] = options;
    }
    public readonly inline_keyboard = youTouchYouDie<[]>(
        "Something went very wrong, how did you manage to run into this error?",
    );
}

function createRenderer<C extends Context, B>(
    ctx: C,
    buttonTransformer: (
        btn: MenuButton<C>,
        row: number,
        col: number,
    ) => MaybePromise<B>,
): (ops: MaybeDynamicRange<C>[]) => Promise<B[][]> {
    async function layout(
        keyboard: Promise<B[][]>,
        range: MaybeDynamicRange<C>,
    ): Promise<B[][]> {
        const k = await keyboard;
        // Make static
        const btns = typeof range === "function" ? await range(ctx) : range;
        // Make raw
        if (btns instanceof ConversationMenuRange) {
            return btns[ops].reduce(layout, keyboard);
        }
        // Replay new buttons on top of partially constructed keyboard
        let first = true;
        for (const row of btns) {
            if (!first) k.push([]);
            const i = k.length - 1;
            for (const button of row) {
                const j = k[i].length;
                const btn = await buttonTransformer(button, i, j);
                k[i].push(btn);
            }
            first = false;
        }
        return k;
    }
    return (ops) => ops.reduce(layout, Promise.resolve([[]]));
}

/**
 * Turns an optional and potentially dynamic string into a regular string for a
 * given context object.
 *
 * @param ctx Context object
 * @param value Potentially dynamic string
 * @param fallback Fallback string value if value is undefined
 * @returns Plain old string
 */
function uniform<C extends Context>(
    ctx: C,
    value: MaybeDynamicString<C> | undefined,
    fallback = "",
): MaybePromise<string> {
    if (value === undefined) return fallback;
    else if (typeof value === "function") return value(ctx);
    else return value;
}
