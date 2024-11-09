/**
 * A resolver wraps a promise so that it can be resolved by an outside event. It
 * is a container for two things:
 *
 * - a promise which you can `await`
 * - a function `resolve` which you can call
 *
 * Once you call `resolve`, the contained promise will resolve.
 *
 * The status flag `isResolved` indicates if `resolve` has been called or not.
 *
 * @typeParam T The type of value to which the promise resolves
 */
export interface Resolver<T> {
    /** The promise which can be resolved by calling `resolve` */
    promise: Promise<T>;
    /** Value of the promise, if is it resolved, and undefined otherwise */
    value?: T;
    /**
     * Resolves the promise of this resolver.
     *
     * Does nothing if called repeatedly.
     */
    resolve(t?: T): void;
    /**
     * A flag indicating whether `resolve` has been called, i.e. whether the
     * promise has been resolved. Returns `false` until `resolve` is called, and
     * returns `true` afterwards.
     */
    isResolved(): this is { value: T };
}
/**
 * Creates a new resolver.
 *
 * Optionally accepts a value to which the promise will resolve when `resolve`
 * is called without arguments. Note that the value will be discarded if
 * `resolve` is called with an argument.
 *
 * @param value An optional default to resolve to when calling `resolve`
 */
export function resolver<T>(value?: T): Resolver<T> {
    const rsr = { value, isResolved: () => false } as Resolver<T>;
    rsr.promise = new Promise((resolve) => {
        rsr.resolve = (t = value) => {
            rsr.isResolved = (): this is { value: T } => true;
            rsr.value = t;
            resolve(t as T); // cast to handle void
            rsr.resolve = () => {}; // double resolve is no-op
        };
    });
    return rsr;
}
