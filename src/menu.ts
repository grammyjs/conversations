import type {
    Context,
    Filter,
    InlineKeyboardButton,
    LoginUrl,
    Middleware,
    SwitchInlineQueryChosenChat,
} from "./deps.deno.ts";

export type ButtonHandler<C extends Context> = (
    ctx: C,
) => unknown | Promise<unknown>;

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
        // TODO: accept menu parent parameter
        if (id === undefined) {
            // generate short and unique identifier that is considered invalid
            // by all other menu instances
            id = `//${this.index.size.toString(36)}`;
        } else if (id.includes("/")) {
            throw new Error(
                `You cannot use '/' in a menu identifier ('${id}')`,
            );
        }
        const menu = new ConversationMenu<C>();
        this.index.set(id, menu);
        return menu;
    }

    async handle(ctx: C): Promise<{ next: boolean }> {
        // TODO: check if callback query
        // TODO: check if menu data query
        // TODO: check if identifier is known
        // TODO: look up menu via identifier
        // TODO: render menu
        await ctx;
        // TODO: pick button
        // TODO: run handler
        // TODO: check if it called next
        // TODO: return this as { next }

        // TODO: if any of the checks fails, return { next: true }

        return { next: true };
    }
}

interface ConversationMenuFlavor {
    match?: string;
    menu: ConversationMenuControlPanel;
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
type ConversationMenuMiddleware<C extends Context> = Middleware<
    Filter<C, "callback_query:data"> & ConversationMenuFlavor
>;
type MaybePromise<T> = T | Promise<T>;
type DynamicString<C extends Context> = (ctx: C) => MaybePromise<string>;
type MaybeDynamicString<C extends Context> = string | DynamicString<C>;
interface TextAndPayload<C extends Context> {
    text: MaybeDynamicString<C>;
    payload?: MaybeDynamicString<C>;
}
type MaybePayloadString<C extends Context> =
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
const ops = Symbol("conversation menu building operations");
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
    // TODO: inline_keyboard stub
    // TODO: rendering
    // TODO: preparing paylaods by swapping out menus by their rendered version
    // TODO: install controls
}
