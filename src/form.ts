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

export type Action<C extends Context> = (ctx: C) => unknown | Promise<unknown>;

export type FormOptions<C extends Context> = Action<C> | FormConfig<C>;
export interface FormConfig<C extends Context> {
    next?: boolean;
    maxMilliseconds?: number;
    collationKey?: string;
    action?: Action<C>;
    otherwise?: Action<C>;
}

export type Maybe<T> = { ok: false } | { ok: true; value: T };
export interface FormBuilder<C extends Context, T> extends FormConfig<C> {
    validate: (ctx: C) => Maybe<T> | Promise<Maybe<T>>;
}

export class ConversationForm<C extends Context> {
    constructor(
        private readonly conversation: {
            wait: (
                opts: { maxMilliseconds?: number; collationKey?: string },
            ) => Promise<C>;
            skip: (opts: { next?: boolean }) => Promise<never>;
        },
    ) {}

    async build<T>(builder: FormBuilder<C, T>) {
        const { validate, action, otherwise, next, ...waitOptions } = builder;
        const ctx = await this.conversation.wait({
            collationKey: "form",
            ...waitOptions,
        });
        const result = await validate(ctx);
        if (result.ok) {
            if (action !== undefined) await action(ctx);
            return result.value;
        } else {
            if (otherwise !== undefined) await otherwise(ctx);
            return await this.conversation.skip({ next });
        }
    }
    async text(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-text",
            ...options,
            validate: (ctx): Maybe<string> => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                return { ok: true, value: text };
            },
        });
    }
    async number(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-number",
            ...options,
            validate: (ctx): Maybe<number> => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                const num = parseFloat(text);
                if (isNaN(num)) return { ok: false };
                return { ok: true, value: num };
            },
        });
    }
    async int(options?: FormOptions<C> & { radix?: number }) {
        const { radix, ...opts } = options ?? {};
        return await this.build({
            collationKey: "form-int",
            ...opts,
            validate: (ctx): Maybe<number> => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                const num = parseInt(text, radix);
                if (isNaN(num)) return { ok: false };
                return { ok: true, value: num };
            },
        });
    }
    async select<E extends string>(entries: E[], options?: FormOptions<C>) {
        const e: string[] = entries;
        return await this.build({
            collationKey: "form-select",
            ...options,
            validate: (ctx): Maybe<E> => {
                const text = (ctx.message ?? ctx.channelPost)?.text;
                if (text === undefined) return { ok: false };
                if (!e.includes(text)) return { ok: false };
                return { ok: true, value: text as E };
            },
        });
    }
    async entity<M extends MessageEntity>(
        type: M["type"],
        options?: FormOptions<C>,
    ) {
        return await this.build({
            collationKey: "form-entity",
            ...options,
            validate: (ctx): Maybe<MessageEntity & { text: string }> => {
                const entities = ctx.entities(type);
                if (entities.length === 0) return { ok: false };
                return { ok: true, value: entities[0] };
            },
        });
    }
    async animation(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-animation",
            ...options,
            validate: (ctx): Maybe<Animation> => {
                const animation = (ctx.message ?? ctx.channelPost)?.animation;
                if (animation === undefined) return { ok: false };
                return { ok: true, value: animation };
            },
        });
    }
    async audio(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-audio",
            ...options,
            validate: (ctx): Maybe<Audio> => {
                const audio = (ctx.message ?? ctx.channelPost)?.audio;
                if (audio === undefined) return { ok: false };
                return { ok: true, value: audio };
            },
        });
    }
    async document(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-document",
            ...options,
            validate: (ctx): Maybe<Document> => {
                const document = (ctx.message ?? ctx.channelPost)?.document;
                if (document === undefined) return { ok: false };
                return { ok: true, value: document };
            },
        });
    }
    async paidMedia(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-paid_media",
            ...options,
            validate: (ctx): Maybe<PaidMediaInfo> => {
                const paid_media = (ctx.message ?? ctx.channelPost)?.paid_media;
                if (paid_media === undefined) return { ok: false };
                return { ok: true, value: paid_media };
            },
        });
    }
    async photo(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-photo",
            ...options,
            validate: (ctx): Maybe<PhotoSize[]> => {
                const photo = (ctx.message ?? ctx.channelPost)?.photo;
                if (photo === undefined) return { ok: false };
                return { ok: true, value: photo };
            },
        });
    }
    async sticker(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-sticker",
            ...options,
            validate: (ctx): Maybe<Sticker> => {
                const sticker = (ctx.message ?? ctx.channelPost)?.sticker;
                if (sticker === undefined) return { ok: false };
                return { ok: true, value: sticker };
            },
        });
    }
    async story(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-story",
            ...options,
            validate: (ctx): Maybe<Story> => {
                const story = (ctx.message ?? ctx.channelPost)?.story;
                if (story === undefined) return { ok: false };
                return { ok: true, value: story };
            },
        });
    }
    async video(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-video",
            ...options,
            validate: (ctx): Maybe<Video> => {
                const video = (ctx.message ?? ctx.channelPost)?.video;
                if (video === undefined) return { ok: false };
                return { ok: true, value: video };
            },
        });
    }
    async video_note(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-video_note",
            ...options,
            validate: (ctx): Maybe<VideoNote> => {
                const video_note = (ctx.message ?? ctx.channelPost)?.video_note;
                if (video_note === undefined) return { ok: false };
                return { ok: true, value: video_note };
            },
        });
    }
    async voice(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-voice",
            ...options,
            validate: (ctx): Maybe<Voice> => {
                const voice = (ctx.message ?? ctx.channelPost)?.voice;
                if (voice === undefined) return { ok: false };
                return { ok: true, value: voice };
            },
        });
    }
    async contact(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-contact",
            ...options,
            validate: (ctx): Maybe<Contact> => {
                const contact = (ctx.message ?? ctx.channelPost)?.contact;
                if (contact === undefined) return { ok: false };
                return { ok: true, value: contact };
            },
        });
    }
    async dice(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-dice",
            ...options,
            validate: (ctx): Maybe<Dice> => {
                const dice = (ctx.message ?? ctx.channelPost)?.dice;
                if (dice === undefined) return { ok: false };
                return { ok: true, value: dice };
            },
        });
    }
    async game(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-game",
            ...options,
            validate: (ctx): Maybe<Game> => {
                const game = (ctx.message ?? ctx.channelPost)?.game;
                if (game === undefined) return { ok: false };
                return { ok: true, value: game };
            },
        });
    }
    async poll(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-poll",
            ...options,
            validate: (ctx): Maybe<Poll> => {
                const poll = (ctx.message ?? ctx.channelPost)?.poll;
                if (poll === undefined) return { ok: false };
                return { ok: true, value: poll };
            },
        });
    }
    async venue(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-venue",
            ...options,
            validate: (ctx): Maybe<Venue> => {
                const venue = (ctx.message ?? ctx.channelPost)?.venue;
                if (venue === undefined) return { ok: false };
                return { ok: true, value: venue };
            },
        });
    }
    async location(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-location",
            ...options,
            validate: (ctx): Maybe<Location> => {
                const location = (ctx.message ?? ctx.channelPost)?.location;
                if (location === undefined) return { ok: false };
                return { ok: true, value: location };
            },
        });
    }
    async media(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-location",
            ...options,
            validate: (ctx): Maybe<PhotoSize[] | Video> => {
                const msg = ctx.message ?? ctx.channelPost;
                const media = msg?.photo ?? msg?.video;
                if (media === undefined) return { ok: false };
                return { ok: true, value: media };
            },
        });
    }
    async file(options?: FormOptions<C>) {
        return await this.build({
            collationKey: "form-location",
            ...options,
            validate: async (ctx): Promise<Maybe<File>> => {
                if (!ctx.has(":file")) return { ok: false };
                const file = await ctx.getFile();
                return { ok: true, value: file };
            },
        });
    }
}
