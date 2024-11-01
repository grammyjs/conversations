import {
    Composer,
    type Context,
    type CopyTextButton,
    type Filter,
    type InlineKeyboardButton,
    type InlineKeyboardMarkup,
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

/** A handler function for a menu button */
export type ButtonHandler<C extends Context> = (
    ctx: C,
) => unknown | Promise<unknown>;

/** Options when creating a menu */
export interface ConversationMenuOptions<C extends Context> {
    /**
     * Identifier of the parent menu. Using a `back` button will navigate to
     * this menu.
     */
    parent?: string | { id: string };
    /**
     * Conversational menus will automatically call `ctx.answerCallbackQuery`
     * with no arguments. If you want to call the method yourself, for example
     * because you need to send custom messages, you can set `autoAnswer` to
     * `false` to disable this behavior.
     */
    autoAnswer: boolean;
    /**
     * Fingerprint function that lets you generate a unique string every time a
     * menu is rendered. Used to determine if a menu is outdated. If specified,
     * replaces the built-in heuristic.
     *
     * Using this option is required if you want to enable compatibility with an
     * outside menu defined by the menu plugin. It is rarely useful if you
     * simply want to define a menu inside a conversation.
     *
     * The built-in heuristic that determines whether a menu is outdated takes
     * the following things into account:
     * - identifier of the menu
     * - shape of the menu
     * - position of the pressed button
     * - potential payload
     * - text of the pressed button
     *
     * If all of these things are identical but the menu is still outdated, you
     * can use this option to supply the neccessary data that lets the menu
     * plugin determine more accurately if the menu is outdated. Similarly, if
     * any of these things differ but you want to consider the menu to be up to
     * date, you can also use this option to signal that.
     *
     * In other words, specifying a fingerprint function will replace the above
     * heuristic entirely by your own implementation.
     */
    fingerprint: DynamicString<C>;
}

/**
 * A container for many menu instances that are created during a replay of a
 * conversation.
 *
 * You typically do not have to construct this class yourself, but it is used
 * internally in order to provide `conversation.menu` inside conversations.
 */
export class ConversationMenuPool<C extends Context> {
    private index: Map<string, ConversationMenu<C>> = new Map();
    private dirty: Map<
        string | number,
        Map<number, { menu: ConversationMenu<C> | undefined }>
    > = new Map();

    /**
     * Marks a menu as dirty. When an API call will be performed that edits the
     * specified message, the given menu will be injected into the payload. If
     * no such API happens while processing an update, the all dirty menus will
     * be updated eagerly using `editMessageReplyMarkup`.
     *
     * @param chat_id The chat identifier of the menu
     * @param message_id The message identifier of the menu
     * @param menu The menu to inject into a payload
     */
    markMenuAsDirty(
        chat_id: string | number,
        message_id: number,
        menu?: ConversationMenu<C>,
    ) {
        let chat = this.dirty.get(chat_id);
        if (chat === undefined) {
            chat = new Map();
            this.dirty.set(chat_id, chat);
        }
        chat.set(message_id, { menu });
    }
    /**
     * Looks up a dirty menu, returns it, and marks it as clean. Returns
     * undefined if the given message does not have a menu that is marked as
     * dirty.
     *
     * @param chat_id The chat identifier of the menu
     * @param message_id The message identifier of the menu
     */
    getAndClearDirtyMenu(chat_id: string | number, message_id: number) {
        const chat = this.dirty.get(chat_id);
        if (chat === undefined) return undefined;
        const message = chat.get(message_id);
        chat.delete(message_id);
        if (chat.size === 0) this.dirty.delete(chat_id);
        return message?.menu;
    }

    /**
     * Creates a new conversational menu with the given identifier and options.
     *
     * If no identifier is specified, an identifier will be auto-generated. This
     * identifier is guaranteed not to clash with any outside menu identifiers
     * used by [the menu plugin](https://grammy.dev/plugins/menu). In contrast,
     * if an identifier is passed that coincides with the identifier of a menu
     * outside the conversation, menu compatibility can be achieved.
     *
     * @param id An optional menu identifier
     * @param options An optional options object
     */
    create(id?: string, options?: Partial<ConversationMenuOptions<C>>) {
        if (id === undefined) {
            id = createId(this.index.size);
        } else if (id.includes("/")) {
            throw new Error(
                `You cannot use '/' in a menu identifier ('${id}')`,
            );
        }
        const menu = new ConversationMenu<C>(id, options);
        this.index.set(id, menu);
        return menu;
    }

    /**
     * Looks up a menu by its identifier and returns the menu. Throws an error
     * if the identifier cannot be found.
     *
     * @param id The menu identifier to look up
     */
    lookup(id: string | { id: string }) {
        const idString = typeof id === "string" ? id : id.id;
        const menu = this.index.get(idString);
        if (menu === undefined) {
            const validIds = Array.from(this.index.keys())
                .map((k) => `'${k}'`)
                .join(", ");
            throw new Error(
                `Menu '${idString}' is not known! Known menus are: ${validIds}`,
            );
        }
        return menu;
    }

    /**
     * Prepares a context object for supporting conversational menus. Returns a
     * function to handle clicks.
     *
     * @param ctx The context object to prepare
     */
    install(ctx: C) {
        // === SETUP RENDERING ===
        /**
         * Renders a conversational menu to a button array.
         *
         * @param id A valid identifier of a conversational menu
         */
        const render = async (id: string) => {
            const self = this.index.get(id);
            if (self === undefined) throw new Error("should never happen");
            const renderer = createDisplayRenderer(id, ctx);
            const rendered = await renderer(self[ops]);
            const fingerprint = await uniform(ctx, self[opts].fingerprint);
            appendHashes(rendered, fingerprint);
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
        ctx.api.config.use(
            // Install a transformer that watches all outgoing payloads for menus
            async (prev, method, payload, signal) => {
                const p: Record<string, unknown> = payload;
                if (Array.isArray(p.results)) {
                    await Promise.all(p.results.map((r) => prepare(r)));
                } else {
                    await prepare(p);
                }
                return await prev(method, payload, signal);
            },
            // Install a transformer that injects dirty menus into API calls
            async (prev, method, payload, signal) => {
                if (
                    INJECT_METHODS.has(method) &&
                    !("reply_markup" in payload) &&
                    "chat_id" in payload &&
                    payload.chat_id !== undefined &&
                    "message_id" in payload &&
                    payload.message_id !== undefined
                ) {
                    Object.assign(payload, {
                        reply_markup: this.getAndClearDirtyMenu(
                            payload.chat_id,
                            payload.message_id,
                        ),
                    });
                }
                return await prev(method, payload, signal);
            },
        );

        // === CHECK INCOMING UPDATES ===
        const skip = { handleClicks: () => Promise.resolve({ next: true }) };
        // Parse callback query data and check if this is for us
        if (!ctx.has("callback_query:data")) return skip;
        const data = ctx.callbackQuery.data;
        const parsed = parseId(data);
        if (parsed === undefined) return skip;
        const { id, parts } = parsed;
        if (parts.length < 4) return skip;
        const [rowStr, colStr, payload, ...rest] = parts;
        const [type, ...h] = rest.join("/");
        const hash = h.join("");
        // Skip handling if this is not a known format
        if (!rowStr || !colStr) return skip;
        if (type !== "h" && type !== "f") return skip;
        // Get identified menu from index
        const menu = this.index.get(id);
        if (menu === undefined) return skip;
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
        const nav = async (
            { immediate }: { immediate?: boolean } = {},
            menu?: ConversationMenu<C>,
        ) => {
            const chat = ctx.chatId;
            if (chat === undefined) {
                throw new Error(
                    "This update does not belong to a chat, so you cannot use this context object to send a menu",
                );
            }
            const message = ctx.msgId;
            if (message === undefined) {
                throw new Error(
                    "This update does not contain a message, so you cannot use this context object to send a menu",
                );
            }
            this.markMenuAsDirty(chat, message, menu);
            if (immediate) await ctx.editMessageReplyMarkup();
        };

        return {
            handleClicks: async () => {
                const controls: ConversationMenuControlPanel = {
                    update: (config) => nav(config, menu),
                    close: (config) => nav(config, undefined),
                    nav: (to, config) => nav(config, this.lookup(to)),
                    back: async (config) => {
                        const p = menu[opts].parent;
                        if (p === undefined) {
                            throw new Error(`Menu ${menu.id} has no parent!`);
                        }
                        await nav(config, this.lookup(p));
                    },
                };
                Object.assign(ctx, { menu: controls });
                // We now have prepared the context for being handled by `menu` so we
                // can actually begin handling the received callback query.
                const mctx = ctx as ConversationMenuContext<C>;
                const menuIsOutdated = async () => {
                    console.error(`conversational menu '${id}' was outdated!`);
                    console.error(new Error("trace").stack);
                    await Promise.all([
                        ctx.answerCallbackQuery(),
                        ctx.editMessageReplyMarkup(),
                    ]);
                };
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
                const renderer = createHandlerRenderer<C>(ctx);
                const range: RawRange<C> = await renderer(menu[ops]);
                // Check dimension
                if (
                    !useFp && (row >= range.length || col >= range[row].length)
                ) {
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
                // Update all dirty menus
                const dirtyChats = Array.from(this.dirty.entries());
                await Promise.all(
                    dirtyChats.flatMap(([chat, messages]) =>
                        Array
                            .from(messages.keys())
                            .map((message) =>
                                ctx.api.editMessageReplyMarkup(chat, message)
                            )
                    ),
                );
                return { next };
            },
        };
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

/**
 * Context flavor for context objects in listeners that react to conversational
 * menus. Provides `ctx.menu`, a control pane for the respective conversational
 * menu.
 */
export interface ConversationMenuFlavor {
    /** Narrows down `ctx.match` to string for menu payloads */
    match?: string;
    /**
     * Control panel for the currently active conversational menu. `ctx.menu` is
     * only available for listeners that are passed as handlers to a
     * conversational menu, and it allows you to perform simple actions such as
     * navigating the menu, or updating or closing it.
     *
     * As an example, if you have a text button that changes its label based on
     * `ctx`, then you should call
     *
     * ```ts
     * ctx.menu.update()
     * ```
     *
     * whenever you mutate some state in such a way that the label should
     * update. The same is true for dynamic ranges that change their layout.
     *
     * If you edit the message yourself after calling one of the functions on
     * `ctx.menu`, the new menu will be automatically injected into the payload.
     * Otherwise, a dedicated API call will be performed after your middleware
     * completes.
     */
    menu: ConversationMenuControlPanel;
}
/**
 * Control panel for conversational menus. Can be used to update or close the
 * conversational menu, or to perform manual navigation between conversational
 * menus.
 */
export interface ConversationMenuControlPanel {
    /**
     * Call this method to update the conversational menu. For instance, if you
     * have a button that changes its text based on `ctx`, then you should call
     * this method to update it.
     *
     * Calling this method will guarantee that the conversational menu is
     * updated, but note that this will perform the update lazily. A new
     * conversational menu is injected into the payload of the request the next
     * time you edit the corresponding message. If you let your middleware
     * complete without editing the message itself again, a dedicated API call
     * will be performed that updates the conversational menu.
     *
     * Pass `{ immediate: true }` to perform the update eagerly instead of
     * lazily. A dedicated API call that updates the conversational menu is sent
     * immediately. In that case, the method returns a Promise that you should
     * `await`. Eager updating may cause flickering of the conversational menu,
     * and it may be slower in some cases.
     */
    update(config: { immediate: true }): Promise<void>;
    update(config?: { immediate?: false }): void;
    /**
     * Closes the conversational menu. Removes all buttons underneath the
     * message.
     *
     * Calling this method will guarantee that the conversational menu is
     * closed, but note that this will be done lazily. A new conversational menu
     * is injected into the payload of the request the next time you edit the
     * corresponding message. If you let your middleware complete without
     * editing the message itself again, a dedicated API call will be performed
     * that closes the conversational menu.
     *
     * Pass `{ immediate: true }` to perform the update eagerly instead of
     * lazily. A dedicated API call that updates the conversational menu is sent
     * immediately. In that case, the method returns a Promise that you should
     * `await`. Eager closing may be slower in some cases.
     */
    close(config: { immediate: true }): Promise<void>;
    close(config?: { immediate?: false }): void;
    /**
     * Navigates to the parent menu. By default, the parent menu is the menu on
     * which you called `register` when installing this menu.
     *
     * Throws an error if this menu does not have a parent menu.
     *
     * Calling this method will guarantee that the navigation is performed, but
     * note that this will be done lazily. A new menu is injected into the
     * payload of the request the next time you edit the corresponding message.
     * If you let your middleware complete without editing the message itself
     * again, a dedicated API call will be performed that performs the
     * navigation.
     *
     * Pass `{ immediate: true }` to navigate eagerly instead of lazily. A
     * dedicated API call is sent immediately. In that case, the method returns
     * a Promise that you should `await`. Eager navigation may cause flickering
     * of the menu, and it may be slower in some cases.
     */
    back(config: { immediate: true }): Promise<void>;
    back(config?: { immediate?: false }): void;
    /**
     * Navigates to the specified conversational submenu. The given identifier
     * is the same string that you pass to `conversation.menu('')`. If you did
     * not pass a string, the identifier will be auto-generated and is
     * accessible via `menu.id`. If you specify the identifier of the current
     * conversational menu itself, this method is equivalent to
     * `ctx.menu.update()`.
     *
     * Calling this method will guarantee that the navigation is performed, but
     * note that this will be done lazily. A new conversational menu is injected
     * into the payload of the request the next time you edit the corresponding
     * message. If you let your middleware complete without editing the message
     * itself again, a dedicated API call will be performed that performs the
     * navigation.
     *
     * Pass `{ immediate: true }` to navigate eagerly instead of lazily. A
     * dedicated API call is sent immediately. In that case, the method returns
     * a Promise that you should `await`. Eager navigation may cause flickering
     * of the conversational menu, and it may be slower in some cases.
     */
    nav(
        to: string | { id: string },
        config: { immediate: true },
    ): Promise<void>;
    nav(to: string | { id: string }, config?: { immediate?: false }): void;
}
/**
 * Type of context objects received by buttons handlers of conversational menus.
 */
export type ConversationMenuContext<C extends Context> =
    & Filter<C, "callback_query:data">
    & ConversationMenuFlavor;
/**
 * Middleware that has access to the `ctx.menu` control panel. This is the type
 * of functions that are used as button handlers in conversational menus.
 */
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
/** A dynamic string, or an object with a text and a payload */
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
/**
 * Button of a conversational menu. Almost the same type as InlineKeyboardButton
 * but with texts that can be generated on the fly, and middleware for callback
 * buttons.
 */
export type MenuButton<C extends Context> = {
    /**
     * Label text on the button, or a function that can generate this text. The
     * function is supplied with the context object that is used to make the
     * request.
     */
    text: MaybeDynamicString<C>;
} & MakeUrlDynamic<C, RemoveAllTexts<NoCb | Cb<C>>>;
type RawRange<C extends Context> = MenuButton<C>[][];
type MaybeRawRange<C extends Context> = ConversationMenuRange<C> | RawRange<C>;
type DynamicRange<C extends Context> = (
    ctx: C,
) => MaybePromise<MaybeRawRange<C>>;
type MaybeDynamicRange<C extends Context> = MaybeRawRange<C> | DynamicRange<C>;
/**
 * A conversational menu range is a two-dimensional array of buttons.
 *
 * This array is a part of the total two-dimensional array of buttons. This is
 * mostly useful if you want to dynamically generate the structure of the
 * conversational menu on the fly.
 */
export class ConversationMenuRange<C extends Context> {
    [ops]: MaybeDynamicRange<C>[] = [];
    /**
     * This method is used internally whenever a new range is added.
     *
     * @param range A range object or a two-dimensional array of menu buttons
     */
    addRange(...range: MaybeDynamicRange<C>[]) {
        this[ops].push(...range);
        return this;
    }
    /**
     * This method is used internally whenever new buttons are added. Adds the
     * buttons to the current row.
     *
     * @param btns Menu button object
     */
    add(...btns: MenuButton<C>[]) {
        return this.addRange([btns]);
    }
    /**
     * Adds a 'line break'. Call this method to make sure that the next added
     * buttons will be on a new row.
     */
    row() {
        return this.addRange([[], []]);
    }
    /**
     * Adds a new URL button. Telegram clients will open the provided URL when
     * the button is pressed. Note that they will not notify your bot when that
     * happens, so you cannot react to this button.
     *
     * @param text The text to display
     * @param url HTTP or tg:// url to be opened when button is pressed. Links tg://user?id=<user_id> can be used to mention a user by their ID without using a username, if this is allowed by their privacy settings.
     */
    url(text: MaybeDynamicString<C>, url: MaybeDynamicString<C>) {
        return this.add({ text, url });
    }
    /**
     * Adds a new text button. You may pass any number of listeners. They will
     * be called when the button is pressed.
     *
     * ```ts
     * menu.text('Hit me!', ctx => ctx.reply('Ouch!'))
     * ```
     *
     * If you pass several listeners, make sure that you understand what
     * [middleware](https://grammy.dev/guide/middleware.html) is.
     *
     * You can also use this method to register a button that depends on the
     * current context.
     *
     * ```ts
     * function greetInstruction(ctx: MyConversationContext): string {
     *   const username = ctx.from?.first_name
     *   return `Greet ${username ?? 'me'}!`,
     * }
     *
     * const menu = conversation.menu()
     *   .text(greetInstruction, ctx => ctx.reply("I'm too shy."))
     *
     * // This will send a conversational menu with one text button,
     * // and the text has the name of the user that the bot is replying to.
     * await ctx.reply('What shall I do?', { reply_markup: menu })
     * ```
     *
     * If you base the text on a variable defined inside the conversation, you
     * can easily create a settings panel with toggle buttons.
     *
     * ```ts
     * // Button will toggle between 'Yes' and 'No' when pressed
     * let flag = true
     * menu.text(ctx => flag ? 'Yes' : 'No', async ctx => {
     *   flag = !flag
     *   ctx.menu.update()
     * })
     * ```
     *
     * @param text The text to display, or a text with payload
     * @param middleware The listeners to call when the button is pressed
     */
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
    /**
     * Adds a new web app button, confer https://core.telegram.org/bots/webapps
     *
     * @param text The text to display
     * @param url An HTTPS URL of a Web App to be opened with additional data
     */
    webApp(text: MaybeDynamicString<C>, url: string) {
        return this.add({ text, web_app: { url } });
    }
    /**
     * Adds a new login button. This can be used as a replacement for the
     * Telegram Login Widget. You must specify an HTTPS URL used to
     * automatically authorize the user.
     *
     * @param text The text to display
     * @param loginUrl The login URL as string or `LoginUrl` object
     */
    login(text: MaybeDynamicString<C>, loginUrl: string | LoginUrl) {
        return this.add({
            text,
            login_url: typeof loginUrl === "string"
                ? { url: loginUrl }
                : loginUrl,
        });
    }
    /**
     * Adds a new inline query button. Telegram clients will let the user pick a
     * chat when this button is pressed. This will start an inline query. The
     * selected chat will be prefilled with the name of your bot. You may
     * provide a text that is specified along with it.
     *
     * Your bot will in turn receive updates for inline queries. You can listen
     * to inline query updates like this:
     *
     * ```ts
     * // Listen for specifc query
     * bot.inlineQuery('my-query', ctx => { ... })
     * // Listen for any query
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * Technically, it is also possible to wait for an inline query inside the
     * conversation using `conversation.waitFor('inline_query')`. However,
     * updates about inline queries do not contain a chat identifier. Hence, it
     * is typically not possible to handle them inside a conversation, as
     * conversation data is stored per chat by default.
     *
     * @param text The text to display
     * @param query The (optional) inline query string to prefill
     */
    switchInline(text: MaybeDynamicString<C>, query = "") {
        return this.add({ text, switch_inline_query: query });
    }
    /**
     * Adds a new inline query button that acts on the current chat. The
     * selected chat will be prefilled with the name of your bot. You may
     * provide a text that is specified along with it. This will start an inline
     * query.
     *
     * Your bot will in turn receive updates for inline queries. You can listen
     * to inline query updates like this:
     *
     * ```ts
     * // Listen for specifc query
     * bot.inlineQuery('my-query', ctx => { ... })
     * // Listen for any query
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * Technically, it is also possible to wait for an inline query inside the
     * conversation using `conversation.waitFor('inline_query')`. However,
     * updates about inline queries do not contain a chat identifier. Hence, it
     * is typically not possible to handle them inside a conversation, as
     * conversation data is stored per chat by default.
     *
     * @param text The text to display
     * @param query The (optional) inline query string to prefill
     */
    switchInlineCurrent(text: MaybeDynamicString<C>, query = "") {
        return this.add({ text, switch_inline_query_current_chat: query });
    }
    /**
     * Adds a new inline query button. Telegram clients will let the user pick a
     * chat when this button is pressed. This will start an inline query. The
     * selected chat will be prefilled with the name of your bot. You may
     * provide a text that is specified along with it.
     *
     * Your bot will in turn receive updates for inline queries. You can listen
     * to inline query updates like this:
     * ```ts
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * Technically, it is also possible to wait for an inline query inside the
     * conversation using `conversation.waitFor('inline_query')`. However,
     * updates about inline queries do not contain a chat identifier. Hence, it
     * is typically not possible to handle them inside a conversation, as
     * conversation data is stored per chat by default.
     *
     * @param text The text to display
     * @param query The query object describing which chats can be picked
     */
    switchInlineChosen(
        text: MaybeDynamicString<C>,
        query: SwitchInlineQueryChosenChat = {},
    ) {
        return this.add({ text, switch_inline_query_chosen_chat: query });
    }
    /**
     * Adds a new copy text button. When clicked, the specified text will be
     * copied to the clipboard.
     *
     * @param text The text to display
     * @param copyText The text to be copied to the clipboard
     */
    copyText(text: string, copyText: string | CopyTextButton) {
        return this.add({
            text,
            copy_text: typeof copyText === "string"
                ? { text: copyText }
                : copyText,
        });
    }
    /**
     * Adds a new game query button, confer
     * https://core.telegram.org/bots/api#games
     *
     * This type of button must always be the first button in the first row.
     *
     * @param text The text to display
     */
    game(text: MaybeDynamicString<C>) {
        return this.add({ text, callback_game: {} });
    }
    /**
     * Adds a new payment button, confer
     * https://core.telegram.org/bots/api#payments
     *
     * This type of button must always be the first button in the first row and can only be used in invoice messages.
     *
     * @param text The text to display
     */
    pay(text: MaybeDynamicString<C>) {
        return this.add({ text, pay: true });
    }
    /**
     * Adds a button that navigates to a given conversational submenu when
     * pressed. You can pass in an instance of another conversational menu, or
     * just the identifier of a conversational menu. This way, you can
     * effectively create a network of conversational menus with navigation
     * between them.
     *
     * You can also navigate to this submenu manually by calling
     * `ctx.menu.nav(menu)`, where `menu` is the target submenu (or its
     * identifier).
     *
     * You can call `submenu.back()` to add a button that navigates back to the
     * parent menu. For this to work, you must specify the `parent` option when
     * creating the conversational menu via `conversation.menu`.
     *
     * @param text The text to display, or a text with payload
     * @param menu The submenu to open, or its identifier
     * @param middleware The listeners to call when the button is pressed
     */
    submenu(
        text: MaybeDynamicString<C>,
        menu: string | { id: string },
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    submenu(
        text: TextAndPayload<C>,
        menu: string | { id: string },
        ...middleware: ConversationMenuMiddleware<C & { match: string }>[]
    ): this;
    submenu(
        text: MaybePayloadString<C>,
        menu: string | { id: string },
        ...middleware: ConversationMenuMiddleware<C>[]
    ): this;
    submenu(
        text: MaybePayloadString<C>,
        menu: string | { id: string },
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
    /**
     * Adds a text button that performs a navigation to the parent menu via
     * `ctx.menu.back()`. For this to work, you must specify the `parent` option
     * when creating the conversational menu via `conversation.menu`.
     *
     * @param text The text to display, or a text with payload
     * @param middleware The listeners to call when the button is pressed
     */
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
    /**
     * This is a dynamic way to initialize the conversational menu. A typical
     * use case is when you want to create an arbitrary conversational menu,
     * using the data from your database:
     *
     * ```ts
     * const menu = conversation.menu()
     * const data = await conversation.external(() => fetchDataFromDatabase())
     * menu.dynamic(ctx => data.reduce((range, entry) => range.text(entry)), new ConversationMenuRange())
     * await ctx.reply("Menu", { reply_markup: menu })
     * ```
     *
     * @param menuFactory Async menu factory function
     */
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
    /**
     * Appends a given range to this range. This will effectively replay all
     * operations of the given range onto this range.
     *
     * @param range A potentially raw range
     */
    append(range: MaybeRawRange<C>) {
        if (range instanceof ConversationMenuRange) {
            this[ops].push(...range[ops]);
            return this;
        } else return this.addRange(range);
    }
}

/**
 * A conversational menu is a set of interactive buttons that is displayed
 * beneath a message. It uses an [inline
 * keyboard](https://grammy.dev/plugins/keyboard.html) for that, so in a sense,
 * a conversational menu is just an inline keyboard spiced up with interactivity
 * (such as navigation between multiple pages).
 *
 * ```ts
 * // Create a simple conversational menu
 * const menu = conversation.menu()
 *   .text('A', ctx => ctx.reply('You pressed A!')).row()
 *   .text('B', ctx => ctx.reply('You pressed B!'))
 *
 * // Send the conversational menu
 * await ctx.reply('Check out this menu:', { reply_markup: menu })
 * ```
 *
 * Check out the [official
 * documentation](https://grammy.dev/plugins/conversations) to see how you can
 * create menus that span several pages, how to navigate between them, and more.
 */
export class ConversationMenu<C extends Context>
    extends ConversationMenuRange<C>
    implements InlineKeyboardMarkup {
    [opts]: ConversationMenuOptions<C>;
    constructor(
        public readonly id: string,
        options: Partial<ConversationMenuOptions<C>> = {},
    ) {
        super();
        this[opts] = {
            parent: options.parent,
            autoAnswer: options.autoAnswer ?? true,
            fingerprint: options.fingerprint ?? (() => ""),
        };
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

function createDisplayRenderer<C extends Context>(id: string, ctx: C) {
    return createRenderer(
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
}
function createHandlerRenderer<C extends Context>(ctx: C) {
    return createRenderer(ctx, (btn: MenuButton<C>) => btn);
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

function appendHashes(keyboard: InlineKeyboardButton[][], fingerprint: string) {
    const lengths = [keyboard.length, ...keyboard.map((row) => row.length)];
    for (const row of keyboard) {
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
}
