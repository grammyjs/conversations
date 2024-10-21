import type { Context } from "./deps.deno.ts";

const PLUGIN_DATA_VERSION = 0;
export interface VersionedState<S> {
    version: [typeof PLUGIN_DATA_VERSION, string | number];
    state: S;
}
export function pinVersion(version: string | number) {
    function versionify<S>(state: S): VersionedState<S> {
        return { version: [PLUGIN_DATA_VERSION, version], state };
    }
    function unpack<S>(data?: VersionedState<S>): S | undefined {
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
    return { versionify, unpack };
}

export type MaybePromise<T> = T | Promise<T>;
export type ConversationStorage<C extends Context, S> =
    | { type?: never; version?: never } & VersionedStateStorage<string, S>
    | ConversationContextStorage<C, S>
    | ConversationKeyStorage<C, S>;
export interface VersionedStateStorage<K, S> {
    read(key: K): MaybePromise<VersionedState<S> | undefined>;
    write(key: K, state: VersionedState<S>): MaybePromise<void>;
    delete(key: K): MaybePromise<void>;
}
export interface ConversationContextStorage<C extends Context, S> {
    version?: string | number;
    type: "context";
    adapter: VersionedStateStorage<C, S>;
}
export interface ConversationKeyStorage<C extends Context, S> {
    version?: string | number;
    type: "key";
    getStorageKey(ctx: C): string | undefined;
    adapter: VersionedStateStorage<string, S>;
}

function defaultStorageKey<C extends Context>(ctx: C): string | undefined {
    return ctx.chatId?.toString();
}
function defaultStorage<C extends Context, S>(): ConversationKeyStorage<C, S> {
    const store = new Map<string, VersionedState<S>>();
    return {
        type: "key",
        getStorageKey: defaultStorageKey,
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
    if (storage.type === undefined) {
        return uniformStorage({
            type: "key",
            getStorageKey: defaultStorageKey,
            adapter: storage,
        });
    }

    const version = storage.version ?? 0;
    const { versionify, unpack } = pinVersion(version);

    if (storage.type === "key") {
        const { getStorageKey, adapter } = storage;
        return (ctx: C) => {
            const key = getStorageKey(ctx);
            return key === undefined
                ? {
                    read: () => undefined,
                    write: () => undefined,
                    delete: () => undefined,
                }
                : {
                    read: async () => unpack(await adapter.read(key)),
                    write: (state: S) => adapter.write(key, versionify(state)),
                    delete: () => adapter.delete(key),
                };
        };
    } else {
        const { adapter } = storage;
        return (ctx: C) => {
            return {
                read: async () => unpack(await adapter.read(ctx)),
                write: (state: S) => adapter.write(ctx, versionify(state)),
                delete: () => adapter.delete(ctx),
            };
        };
    }
}
