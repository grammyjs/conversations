import type { Context } from "./deps.deno.ts";

const PLUGIN_DATA_VERSION = 0;
export interface VersionedState<S> {
    version: [typeof PLUGIN_DATA_VERSION, string | number];
    state: S;
}

export type MaybePromise<T> = T | Promise<T>;
export type ConversationStorage<C extends Context, S> =
    | ConversationContextStorage<C, S>
    | ConversationKeyStorage<C, S>;
export interface ConversationContextStorage<C extends Context, S> {
    version?: string | number;

    adapter?: never;

    read(ctx: C): MaybePromise<VersionedState<S> | undefined>;
    write(ctx: C, state: VersionedState<S>): MaybePromise<void>;
    delete(ctx: C): MaybePromise<void>;
}
export interface ConversationKeyStorage<C extends Context, S> {
    version?: string | number;

    getStorageKey(ctx: C): string | undefined;
    adapter: {
        read(key: string): MaybePromise<VersionedState<S> | undefined>;
        write(key: string, state: VersionedState<S>): MaybePromise<void>;
        delete(key: string): MaybePromise<void>;
    };

    read?: never;
    write?: never;
    delete?: never;
}

function defaultStorage<C extends Context, S>(): ConversationKeyStorage<C, S> {
    const store = new Map<string, VersionedState<S>>();
    return {
        getStorageKey: (ctx) => ctx.chatId?.toString(),
        adapter: {
            read: (key) => store.get(key),
            write: (key, state) => void store.set(key, state),
            delete: (key) => void store.delete(key),
        },
    };
}
export function uniformStorage<C extends Context, S>(
    storage: ConversationStorage<C, S> = defaultStorage(),
) {
    const version = storage.version ?? 0;
    function addVersion(state: S): VersionedState<S> {
        return { version: [PLUGIN_DATA_VERSION, version], state };
    }
    function migrate(data?: VersionedState<S>): S | undefined {
        if (data === undefined) return undefined;
        const [pluginVersion, dataVersion] = data.version;
        if (dataVersion !== version) return undefined;
        if (pluginVersion !== PLUGIN_DATA_VERSION) {
            // In the future, we might want to migrate the data from an old
            // plugin version to a new one here.
            return undefined;
        }
        return data.state;
    }

    if ("getStorageKey" in storage) {
        return (ctx: C) => {
            const key = storage.getStorageKey(ctx);
            return key === undefined
                ? {
                    read: () => undefined,
                    write: () => undefined,
                    delete: () => undefined,
                }
                : {
                    read: async () => migrate(await storage.adapter.read(key)),
                    write: (state: S) =>
                        storage.adapter.write(key, addVersion(state)),
                    delete: () => storage.adapter.delete(key),
                };
        };
    } else {
        return (ctx: C) => {
            return {
                read: async () => migrate(await storage.read(ctx)),
                write: (state: S) => storage.write(ctx, addVersion(state)),
                delete: () => storage.delete(ctx),
            };
        };
    }
}
