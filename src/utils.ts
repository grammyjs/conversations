/** Identity function */
export function ident<T>(arg: T) {
    return arg;
}

// Define which context properties are intrinsic to grammY or this plugin and
// should not be stored in the op logs
const INTRINSIC_CONTEXT_PROPS = new Set([
    "update",
    "api",
    "me",
    "conversation",
    "session",
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
export interface Resolver {
    /** The promise which can be resolved by calling `resolve` */
    promise: Promise<void>;
    /** Resolves the promise of this resolver */
    resolve: () => void;
    /**
     * A flag indicating whether `resolve` has been called, i.e. whether the
     * promise has been resolved. Has the value `true` until `resolve` is
     * called.
     */
    isResolved: boolean;
}
/** Creates a new resolver */
export function resolver(): Resolver {
    const rsr: Resolver = {
        isResolved: false,
        // those two will be overwritten immediately:
        resolve: () => {},
        promise: Promise.resolve(),
    };
    rsr.promise = new Promise((resolve) => {
        rsr.resolve = () => {
            rsr.isResolved = true;
            resolve();
        };
    });
    return rsr;
}
