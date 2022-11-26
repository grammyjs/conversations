import { delistify, listify } from "./deps.deno.ts";

/** Identity function */
export function ident<T>(arg: T) {
    return arg;
}

/**
 * Performs a structured clone, ignoring non-enumerable properties such as
 * functions.
 */
export function clone<T>(arg: T) {
    // TODO: replace ugly hack with better cloning
    const list = listify(arg);
    if (Array.isArray(list) && list.length === 0) return undefined;
    return delistify(list);
}

// Define which context properties are intrinsic to grammY or this plugin and
// should not be stored in the op logs
const INTRINSIC_CONTEXT_PROPS = new Set([
    "update",
    "api",
    "me",
    "conversation",
]);
export function IS_NOT_INTRINSIC(key: string) {
    return !INTRINSIC_CONTEXT_PROPS.has(key);
}

/**
 * A resolver wraps a promise so that it can be resolved by an outside event. It
 * is a container for this promise which you can `await`, and a function
 * `resolve` which you can call. Once you call `resolve`, the contained promise
 * will resolve.
 *
 * The status flag `isResolved` indicates if `resolve` has been called or not.
 */
export interface Resolver<T> {
    /** The promise which can be resolved by calling `resolve` */
    promise: Promise<T>;
    /** Value of the promise, if is it resolved, and undefined otherwise */
    value?: T;
    /** Resolves the promise of this resolver */
    resolve(t?: T): void;
    /**
     * A flag indicating whether `resolve` has been called, i.e. whether the
     * promise has been resolved. Has the value `true` until `resolve` is
     * called.
     */
    isResolved(): this is { value: T };
}
/** Creates a new resolver */
export function resolver<T>(value?: T): Resolver<T> {
    const rsr = { value, isResolved: () => false } as Resolver<T>;
    rsr.promise = new Promise((resolve) => {
        rsr.resolve = (t = value) => {
            if (t === undefined) throw new Error("No resolve value given!");
            rsr.isResolved = () => true;
            rsr.value = t;
            resolve(t);
        };
    });
    return rsr;
}
