import type { Context } from "./deps.deno.ts";

/** Current data version of this plugin */
export const PLUGIN_DATA_VERSION = 0;

/**
 * A value with a version.
 *
 * The version consists of two pieces.
 *
 * The first piece is a number that is defined by the plugin internally and
 * cannot be changed. When the plugin is updated and it changes its internal
 * data format, then it can use this part of the version to detect and
 * automatically migrate the versioned state as necessary.
 *
 * The second piece is a number or a string and can be set by the developer. It
 * should be changed whenever the application code changes in a way that
 * invalidates the state. The plugin can then discard and re-create the state as
 * necesarry.
 *
 * Versioned states are typically created via the {@link pinVersion} function.
 *
 * @typeParam S The type of the state to be versioned
 */
export interface VersionedState<S> {
    /** The version of the state */
    version: [typeof PLUGIN_DATA_VERSION, string | number];
    /** The state to be versioned */
    state: S;
}

/**
 * A container for two functions that are pinned to a specific version. The two
 * functions can be used to add the bound version to data, and to unpack the
 * data again. This container is typically created using {@link pinVersion}.
 */
export interface PinnedVersion {
    /**
     * Adds a version to some data.
     *
     * @param state Some data
     */
    versionify<S>(state: S): VersionedState<S>;
    /**
     * Unpacks some versioned data. Returns the original data if the data is
     * correct, and `undefined` otherwise. If `undefined` is passed, then
     * `undefined` will be returned.
     *
     * @param data Some versioned data or `undefined`
     */
    unpack<S>(data?: VersionedState<S>): S | undefined;
}

/**
 * Takes a version number and state management functions that are pinned to this
 * version.
 *
 * The two functions it returns are `versionify` and `unpack`. The former can be
 * used to add a version to some data. The latter can be used to unpack the data
 * again, validating the version on the fly.
 *
 * ```ts
 * import { assert } from "jsr:@std/assert";
 *
 * const { versionify, unpack } = pinVersion(42);
 *
 * const data = { prop: "pizza" };
 * const versioned = versionify(data);
 * const unpacked = unpack(versioned);
 * assert(data === unpacked);
 * ```
 *
 * @param version the version to use for pinning
 */
export function pinVersion(version: string | number): PinnedVersion {
    function versionify<S>(state: S): VersionedState<S> {
        return { version: [PLUGIN_DATA_VERSION, version], state };
    }
    function unpack<S>(data?: VersionedState<S>): S | undefined {
        if (data === undefined || !Array.isArray(data.version)) return undefined;
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

/**
 * A value or a promise of a value.
 *
 * @typeParam T The type of value
 */
export type MaybePromise<T> = T | Promise<T>;
/**
 * A storage for versioned state.
 *
 * Specify this to define how to persist data.
 *
 * This type is a union of three types, each representing a different way to
 * store data.
 *
 * 1. A {@link VersionedStateStorage} directly provides definitions for reading,
 *    writing, and deleting data based on `ctx.chatId`. No versions can be
 *    specified and the storage key function cannot be changed.
 * 2. A {@link ConversationKeyStorage}, disambiguated via `{ type: "key" }`, is
 *    more general. It supports versioning the data and changing the storage key
 *    function.
 * 3. A {@link ConversationContextStorage}, disambiguated via `{ type: "context"
 *    }`, is even more general. It no longer needs a storage key function.
 *    Instead, it provides read, write, and delete operations for data based on
 *    the context object directly. It also supports versioning data.
 *
 * @typeParam C A custom context type
 * @typeParam S A type for the state to version and store
 */
export type ConversationStorage<C extends Context, S> =
    | { type?: never; version?: never } & VersionedStateStorage<string, S>
    | ConversationContextStorage<C, S>
    | ConversationKeyStorage<C, S>;
/**
 * An object that defines how to read, write, and delete versioned data based on
 * a key.
 *
 * @typeParam K The type of key to use
 * @typeParam S The type of data to store
 */
export interface VersionedStateStorage<K, S> {
    /**
     * Reads the data for a given key.
     *
     * @param key A key to identify the data
     */
    read(key: K): MaybePromise<VersionedState<S> | undefined>;
    /**
     * Writes some data to the storage for a given key.
     *
     * @param key A key to identify the data
     * @param state The data to write
     */
    write(key: K, state: VersionedState<S>): MaybePromise<void>;
    /**
     * Deletes some data from the storage for a given key.
     *
     * @param key A key to identify the data
     */
    delete(key: K): MaybePromise<void>;
}
/**
 * An object that defines how to read, write, or delete versioned data based on
 * a context object.
 */
export interface ConversationContextStorage<C extends Context, S> {
    /** The type of storage, always `"context"` */
    type: "context";
    /** An optional version for the data, defaults to `0` */
    version?: string | number;
    /** The underlying storage that defines how to read and write raw data */
    adapter: VersionedStateStorage<C, S>;
}
export interface ConversationKeyStorage<C extends Context, S> {
    /** The type of storage, always `"key"` */
    type: "key";
    /** An optional version for the data, defaults to `0` */
    version?: string | number;
    /** An optional storage key function, defaults to `ctx.chatId` */
    getStorageKey?(ctx: C): string | undefined;
    /** The underlying storage that defines how to read and write raw data */
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
/**
 * Coerces different storages to a single uniform abstraction.
 *
 * This function takes a {@link ConversationStorage} object and unifies its
 * union members behind a common abstraction that simply exposes a read, write,
 * and delete method for a given context object.
 *
 * @param storage An object defining how to store data
 */
export function uniformStorage<C extends Context, S>(
    storage?: ConversationStorage<C, S>,
): (
    ctx: C,
) => {
    read: () => MaybePromise<S | undefined>;
    write: (state: S) => MaybePromise<void>;
    delete: () => MaybePromise<void>;
} {
    storage ??= defaultStorage();
    if (storage.type === undefined) {
        return uniformStorage({ type: "key", adapter: storage });
    }

    const version = storage.version ?? 0;
    const { versionify, unpack } = pinVersion(version);

    if (storage.type === "key") {
        const { getStorageKey = defaultStorageKey, adapter } = storage;
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
