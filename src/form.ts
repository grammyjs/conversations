import type {
    Animation,
    Audio,
    Contact,
    Context,
    Dice,
    Document,
    File,
    Game,
    Location,
    MessageEntity,
    PaidMediaInfo,
    PhotoSize,
    Poll,
    Sticker,
    Story,
    Venue,
    Video,
    VideoNote,
    Voice,
} from "./deps.deno.ts";

/**
 * An action to perform after a context object passed form valiation.
 *
 * A form action receives the validated context object as the first argument. It
 * receives the extracted value as a second argument.
 *
 * @param ctx The current context object
 * @param result The value returned by the form field
 * @typeParam C A custom context type
 * @typeParam T The type of form field
 */
export type FormAction<C extends Context, T> = (
    ctx: C,
    result: T,
) => unknown | Promise<unknown>;
/**
 * A callback function to be invoked after a context object failed form
 * validation.
 *
 * A form action receives the rejected context object as the first argument.
 *
 * If validation fails and an error is specified, it is possible to use
 * {@link OtherwiseWithReason} instead.
 *
 * @param ctx The current context object
 * @typeParam C A custom context type
 */
export type Otherwise<C extends Context> = (
    ctx: C,
) => unknown | Promise<unknown>;
/**
 * A callback function to be invoked after a context object failed form
 * validation.
 *
 * A form action receives the rejected context object as the first argument.
 *
 * If validation fails and a reason is specified as an error of the
 * {@link Result} return value of the validation function, the form action
 * receives the error as a second argument. If no reason was specified, use
 * {@link Otherwise} instead.
 *
 * @param ctx The current context object
 * @param reason A reason why validation failed
 * @typeParam C A custom context type
 * @typeParam R A type of reason defined by the validation function
 */
export type OtherwiseWithReason<C extends Context, R> = (
    ctx: C,
    reason: R,
) => unknown | Promise<unknown>;
/**
 * Options to pass to a form field. Can be either a {@link FormAction} function
 * or a {@link FormConfig} object.
 *
 * If the validation function is able to provide a reason as to why validation
 * has failed, it is possible use {@link FormOptionsWithReason} instead.
 *
 * @typeParam C A custom context type
 * @typeParam C A form field type
 */
export type FormOptions<C extends Context, T> =
    | FormAction<C, T>
    | FormConfig<C, T>;
/**
 * Options to pass to a form field with an enhanced validation function that can
 * provide a reason as to why validation has failed. Can be either a
 * {@link FormAction} function or a {@link FormConfigWithReason} object.
 *
 * If the validation function does not provide a reason, use {@link FormOptions}
 * instead.
 *
 * @typeParam C A custom context type
 * @typeParam T A type of success value for the validation function
 * @typeParam R A type of error value for the validation function
 */
export type FormOptionsWithReason<C extends Context, T, R> =
    | FormAction<C, T>
    | FormConfigWithReason<C, T, R>;
/**
 * A base options bag object for a form field. This holds all properties that
 * are common among {@link FormConfig} and {@link FormConfigWithReason}.
 *
 * @typeParam C A custom context type
 * @typeParam T A form field type
 */
export interface FormConfigShared<C extends Context, T> {
    /**
     * Determines whether [the outside middleware
     * system](https://grammy.dev/guide/middleware) should resume after the
     * update is skipped in case that form validation fails.
     *
     * Specify `next: true` to make sure that subsequent handlers will run. This
     * effectively causes `next` to be called by the plugin.
     *
     * Defaults to `false` unless the conversation is marked as parallel, in
     * which case this option defaults to `true`.
     */
    next?: boolean;
    /**
     * Specifies a timeout for the wait call.
     *
     * When the form field is reached, `Date.now()` is called. When the form
     * field resolves, `Date.now()` is called again, and the two values are
     * compared. If the form field resolved more than the specified number of
     * milliseconds after it was reached initially, then the conversation will
     * be halted, any exit handlers will be called, and the surrounding
     * middleware will resume normally so that subsequent handlers can run.
     *
     * To the outside middleware system, this will look like the conversation
     * was never active.
     */
    maxMilliseconds?: number;
    /**
     * Collation key for the wait call, safety measure to protect against data
     * corruption. This is used extensively by the plugin internally, but it is
     * rarely useful to changes this behavior.
     */
    collationKey?: string;
    /**
     * A form action to perform on the context object after the form validation
     * succeeds for a context object, and before the respective value is
     * returned form the form field.
     */
    action?: FormAction<C, T>;
}
/**
 * An options bag object for a form field. Contains all properties of
 * {@link FormConfigShared} as well as an `otherwise` function to be invoked
 * when form valiation fails.
 *
 * If a reason is specified by the form validation, it is possible to use
 * {@link FormConfigWithReason} instead.
 *
 * @typeParam C A custom context type
 * @typeParam T A form field type
 */
export interface FormConfig<C extends Context, T>
    extends FormConfigShared<C, T> {
    /**
     * Callback that will be invoked when the form validation fails for a
     * context object.
     */
    otherwise?: Otherwise<C>;
}
/**
 * An options bag object for a form field. Contains all properties of
 * {@link FormConfigShared} as well as an `otherwise` function to be invoked
 * when form valiation fails with a known reason.
 *
 * If no reason is specified by the form validation, use {@link FormConfig}
 * instead.
 *
 * @typeParam C A custom context type
 * @typeParam T A type of success value for the validation function
 * @typeParam R A type of error value for the validation function
 */
export interface FormConfigWithReason<C extends Context, T, R>
    extends FormConfigShared<C, T> {
    /**
     * Callback that will be invoked when the form validation fails with a
     * reason for a context object.
     */
    otherwise?: OtherwiseWithReason<C, R>;
}

/** A value that may be absent */
export type Maybe<T> = { ok: false } | { ok: true; value: T };
/** A value or an error */
export type Result<T, E> = { ok: false; error: E } | { ok: true; value: T };
/**
 * An object that fully specifies how to build a form field.
 *
 * Contains as properties of {@link FormConfig} as well as a function that can
 * validate context objects.
 *
 * If the validation function can provide a reason as to why validation has
 * failed, it is possible to use {@link FormBuilderWithReason} instead.
 *
 * @typeParam C A custom context type
 * @typeParam T The type of value this form field returns
 */
export interface FormBuilder<C extends Context, T> extends FormConfig<C, T> {
    /**
     * A function that validates a given context.
     *
     * When validation succeeds, a value can be extracted from the context
     * object. The result of the validation as well as the data extraction needs
     * to be encoded using a {@link Maybe} type.
     *
     * @param ctx A context object to validate
     */
    validate(ctx: C): Maybe<T> | Promise<Maybe<T>>;
}
/**
 * An object that fully specifies how to build a form field.
 *
 * Contains as properties of {@link FormConfigWithReason} as well as a function
 * that can validate context objects. If a context object does not pass
 * validation, the validation function is able to provide a reason.
 *
 * If the validation function cannot provide reason as to why validation has
 * failed, it is possible to use {@link FormBuilder} instead.
 *
 * @typeParam C A custom context type
 * @typeParam T A type of success value for the validation function
 * @typeParam R A type of error value for the validation function
 */
export interface FormBuilderWithReason<C extends Context, T, R>
    extends FormConfigWithReason<C, T, R> {
    /**
     * A function that validates a given context.
     *
     * When validation succeeds, a value can be extracted from the context
     * object. When validation fails, an error can be generated. The result of
     * the validation needs to be encoded using a {@link Result} type.
     *
     * @param ctx A context object to validate
     */
    validate(ctx: C): Result<T, R> | Promise<Result<T, R>>;
}

/**
 * A container for form building utilities.
 *
 * Each method on this class represents a differnt type of form field which can
 * validate context objects and extract data from it.
 */
export class ConversationForm<C extends Context> {
    /** Constructs a new form based on wait and skip callbacks */
    constructor(
        private readonly conversation: {
            wait: (
                opts: { maxMilliseconds?: number; collationKey?: string },
            ) => Promise<C>;
            skip: (opts: { next?: boolean }) => Promise<never>;
        },
    ) {}

    /**
     * Generic form field that can be used to build any other type of form
     * field. This is heavily used internally.
     *
     *  Most likely, you will not need this because there is a more convenient
     *  option. However, you can still use it if the type of form field you need
     *  is not supported out of the box.
     *
     * @param builder A form field definition object
     * @typeParam T A type of value to be extracted from the form field
     * @typeParam R A type of reason to be specified if validation fails
     */
    async build<T, R>(builder: FormBuilderWithReason<C, T, R>): Promise<T>;
    async build<T, R>(builder: FormBuilder<C, T>): Promise<T>;
    async build<T, R>(
        builder: FormBuilder<C, T> | FormBuilderWithReason<C, T, R>,
    ) {
        const { validate, action, otherwise, next, ...waitOptions } = builder;
        const ctx = await this.conversation.wait({
            collationKey: "form",
            ...waitOptions,
        });
        const result: Maybe<T> | Result<T, R> = await validate(ctx);
        if (result.ok) {
            if (action !== undefined) await action(ctx, result.value);
            return result.value;
        } else {
            if (otherwise !== undefined) {
                if ("error" in result) {
                    const callback = otherwise;
                    const reason = result.error as R;
                    await callback(ctx, reason);
                } else {
                    const callback = otherwise as FormBuilder<C, T>["validate"];
                    await callback(ctx);
                }
            }
            return await this.conversation.skip({ next });
        }
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with text, and returns this text as string. Does not check
     * for captions.
     *
     * Accepts an optional options object that lets you perform actions when
     * text is received, when a non-text update is received, and more.
     *
     * @param options Optional options
     */
    async text(options?: FormOptions<C, string>) {
        return await this.build({
            collationKey: "form-text",
            ...options,
            validate: (ctx) => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                return { ok: true, value: text };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with text that can be parsed to a number, and returns this
     * number. Does not check captions.
     *
     * The conversion to number uses `parseFloat`.
     *
     * Accepts an optional options object that lets you perform actions when a
     * number is received, when a non-number update is received, and more.
     *
     * @param options Optional options
     */
    async number(options?: FormOptions<C, number>) {
        return await this.build({
            collationKey: "form-number",
            ...options,
            validate: (ctx) => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                const num = parseFloat(text);
                if (isNaN(num)) return { ok: false };
                return { ok: true, value: num };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with text that can be parsed to an integer, and returns this
     * integer as a `number`. Does not check for captions.
     *
     * The conversion to number uses `parseInt`.
     *
     * Accepts an optional options object that lets you specify the radix to use
     * as well as perform actions when a number is received, when a non-number
     * update is received, and more.
     *
     * @param options Optional options
     */
    async int(
        options?: FormOptions<C, number> & {
            /** The radix to use for parsing the integer */
            radix?: number;
        },
    ) {
        const { radix, ...opts } = options ?? {};
        return await this.build({
            collationKey: "form-int",
            ...opts,
            validate: (ctx) => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                const num = parseInt(text, radix);
                if (isNaN(num)) return { ok: false };
                return { ok: true, value: num };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with one of several predefined strings, and returns the
     * actual text as string. Does not check captions.
     *
     * This is especially useful when working with custom keyboards.
     *
     * ```ts
     * const keyboard = new Keyboard()
     *   .text("A").text("B")
     *   .text("C").text("D")
     *   .oneTime()
     * await ctx.reply("A, B, C, or D?", { reply_markup: keyboard })
     * const answer = await conversation.form.select(["A", "B", "C", "D"], {
     *   otherwise: ctx => ctx.reply("Please use one of the buttons!")
     * })
     * switch (answer) {
     *   case "A":
     *   case "B":
     *   case "C":
     *   case "D":
     *   // ...
     * }
     * ```
     *
     * Accepts an optional options object that lets you perform actions when
     * text is received, when a non-text update is received, and more.
     *
     * @param entries A string array of accepted values
     * @param options Optional options
     */
    async select<E extends string>(entries: E[], options?: FormOptions<C, E>) {
        const e: string[] = entries;
        return await this.build({
            collationKey: "form-select",
            ...options,
            validate: (ctx) => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                if (!e.includes(text)) return { ok: false };
                return { ok: true, value: text as E };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a given type of message entity, and returns this
     * entity. The form field relies on `ctx.entities()` for data extraction, so
     * both texts and captions are checked.
     *
     * Accepts an optional options object that lets you perform actions when
     * text is received, when a non-text update is received, and more.
     *
     * @param type One or more types of message entities to accept
     * @param options Optional options
     */
    async entity<M extends MessageEntity>(
        type: M["type"] | M["type"][],
        options?: FormOptions<C, MessageEntity & { text: string }>,
    ) {
        return await this.build({
            collationKey: "form-entity",
            ...options,
            validate: (ctx) => {
                const entities = ctx.entities(type);
                if (entities.length === 0) return { ok: false };
                return { ok: true, value: entities[0] };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with an animation, and returns the received animation
     * object.
     *
     * Accepts an optional options object that lets you perform actions when an
     * animation is received, when a non-animation update is received, and more.
     *
     * @param options Optional options
     */
    async animation(options?: FormOptions<C, Animation>) {
        return await this.build({
            collationKey: "form-animation",
            ...options,
            validate: (ctx) => {
                const animation = (ctx.message ?? ctx.channelPost)?.animation;
                if (animation === undefined) return { ok: false };
                return { ok: true, value: animation };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with an audio message, and returns the received audio
     * object.
     *
     * Accepts an optional options object that lets you perform actions when an
     * audio message is received, when a non-audio update is received, and more.
     *
     * @param options Optional options
     */
    async audio(options?: FormOptions<C, Audio>) {
        return await this.build({
            collationKey: "form-audio",
            ...options,
            validate: (ctx) => {
                const audio = (ctx.message ?? ctx.channelPost)?.audio;
                if (audio === undefined) return { ok: false };
                return { ok: true, value: audio };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a document message, and returns the received document
     * object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * document message is received, when a non-document update is received, and
     * more.
     *
     * @param options Optional options
     */
    async document(options?: FormOptions<C, Document>) {
        return await this.build({
            collationKey: "form-document",
            ...options,
            validate: (ctx) => {
                const document = (ctx.message ?? ctx.channelPost)?.document;
                if (document === undefined) return { ok: false };
                return { ok: true, value: document };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with paid media, and returns the received paid media object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * paid media message is received, when a non-paid media update is received,
     * and more.
     *
     * @param options Optional options
     */
    async paidMedia(options?: FormOptions<C, PaidMediaInfo>) {
        return await this.build({
            collationKey: "form-paid_media",
            ...options,
            validate: (ctx) => {
                const paid_media = (ctx.message ?? ctx.channelPost)?.paid_media;
                if (paid_media === undefined) return { ok: false };
                return { ok: true, value: paid_media };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a photo, and returns the received array of `PhotoSize`
     * objects.
     *
     * Accepts an optional options object that lets you perform actions when a
     * photo is received, when a non-photo update is received, and more.
     *
     * @param options Optional options
     */
    async photo(options?: FormOptions<C, PhotoSize[]>) {
        return await this.build({
            collationKey: "form-photo",
            ...options,
            validate: (ctx) => {
                const photo = (ctx.message ?? ctx.channelPost)?.photo;
                if (photo === undefined) return { ok: false };
                return { ok: true, value: photo };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a sticker, and returns the received sticker object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * sticker is received, when a non-sticker update is received, and more.
     *
     * @param options Optional options
     */
    async sticker(options?: FormOptions<C, Sticker>) {
        return await this.build({
            collationKey: "form-sticker",
            ...options,
            validate: (ctx) => {
                const sticker = (ctx.message ?? ctx.channelPost)?.sticker;
                if (sticker === undefined) return { ok: false };
                return { ok: true, value: sticker };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a story, and returns the received story object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * story is received, when a non-story update is received, and more.
     *
     * @param options Optional options
     */
    async story(options?: FormOptions<C, Story>) {
        return await this.build({
            collationKey: "form-story",
            ...options,
            validate: (ctx) => {
                const story = (ctx.message ?? ctx.channelPost)?.story;
                if (story === undefined) return { ok: false };
                return { ok: true, value: story };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a video, and returns the received video object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * video is received, when a non-video update is received, and more.
     *
     * @param options Optional options
     */
    async video(options?: FormOptions<C, Video>) {
        return await this.build({
            collationKey: "form-video",
            ...options,
            validate: (ctx) => {
                const video = (ctx.message ?? ctx.channelPost)?.video;
                if (video === undefined) return { ok: false };
                return { ok: true, value: video };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a video note, and returns the received video note
     * object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * video note is received, when a non-video note update is received, and
     * more.
     *
     * @param options Optional options
     */
    async video_note(options?: FormOptions<C, VideoNote>) {
        return await this.build({
            collationKey: "form-video_note",
            ...options,
            validate: (ctx) => {
                const video_note = (ctx.message ?? ctx.channelPost)?.video_note;
                if (video_note === undefined) return { ok: false };
                return { ok: true, value: video_note };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a voice message, and returns the received voice object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * voice message is received, when a non-voice message update is received,
     * and more.
     *
     * @param options Optional options
     */
    async voice(options?: FormOptions<C, Voice>) {
        return await this.build({
            collationKey: "form-voice",
            ...options,
            validate: (ctx) => {
                const voice = (ctx.message ?? ctx.channelPost)?.voice;
                if (voice === undefined) return { ok: false };
                return { ok: true, value: voice };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a contact, and returns the received contact object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * contact is received, when a non-contact update is received, and more.
     *
     * @param options Optional options
     */
    async contact(options?: FormOptions<C, Contact>) {
        return await this.build({
            collationKey: "form-contact",
            ...options,
            validate: (ctx) => {
                const contact = (ctx.message ?? ctx.channelPost)?.contact;
                if (contact === undefined) return { ok: false };
                return { ok: true, value: contact };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with dice, and returns the received dice object.
     *
     * Accepts an optional options object that lets you perform actions when
     * dice are received, when a non-dice update is received, and more.
     *
     * @param options Optional options
     */
    async dice(options?: FormOptions<C, Dice>) {
        return await this.build({
            collationKey: "form-dice",
            ...options,
            validate: (ctx) => {
                const dice = (ctx.message ?? ctx.channelPost)?.dice;
                if (dice === undefined) return { ok: false };
                return { ok: true, value: dice };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a game, and returns the received game object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * game is received, when a non-game update is received, and more.
     *
     * @param options Optional options
     */
    async game(options?: FormOptions<C, Game>) {
        return await this.build({
            collationKey: "form-game",
            ...options,
            validate: (ctx) => {
                const game = (ctx.message ?? ctx.channelPost)?.game;
                if (game === undefined) return { ok: false };
                return { ok: true, value: game };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a poll, and returns the received poll object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * poll is received, when a non-poll update is received, and more.
     *
     * @param options Optional options
     */
    async poll(options?: FormOptions<C, Poll>) {
        return await this.build({
            collationKey: "form-poll",
            ...options,
            validate: (ctx) => {
                const poll = (ctx.message ?? ctx.channelPost)?.poll;
                if (poll === undefined) return { ok: false };
                return { ok: true, value: poll };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a venue, and returns the received venue object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * venue is received, when a non-venue update is received, and more.
     *
     * @param options Optional options
     */
    async venue(options?: FormOptions<C, Venue>) {
        return await this.build({
            collationKey: "form-venue",
            ...options,
            validate: (ctx) => {
                const venue = (ctx.message ?? ctx.channelPost)?.venue;
                if (venue === undefined) return { ok: false };
                return { ok: true, value: venue };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a location, and returns the received location object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * location is received, when a non-location update is received, and more.
     *
     * @param options Optional options
     */
    async location(options?: FormOptions<C, Location>) {
        return await this.build({
            collationKey: "form-location",
            ...options,
            validate: (ctx) => {
                const location = (ctx.message ?? ctx.channelPost)?.location;
                if (location === undefined) return { ok: false };
                return { ok: true, value: location };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a photo or video, and returns the received media
     * object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * media is received, when a non-media update is received, and more.
     *
     * @param options Optional options
     */
    async media(options?: FormOptions<C, PhotoSize[] | Video>) {
        return await this.build({
            collationKey: "form-location",
            ...options,
            validate: (ctx) => {
                const msg = ctx.message ?? ctx.channelPost;
                const media = msg?.photo ?? msg?.video;
                if (media === undefined) return { ok: false };
                return { ok: true, value: media };
            },
        });
    }
    /**
     * Form field that checks if the incoming update contains a message or
     * channel post with a file, calls `await ctx.getFile()`, and returns the
     * received file object.
     *
     * Accepts an optional options object that lets you perform actions when a
     * file is received, when a non-file update is received, and more.
     *
     * @param options Optional options
     */
    async file(options?: FormOptions<C, File>) {
        return await this.build({
            collationKey: "form-location",
            ...options,
            validate: async (ctx) => {
                if (!ctx.has(":file")) return { ok: false };
                const file = await ctx.getFile();
                return { ok: true, value: file };
            },
        });
    }
}
