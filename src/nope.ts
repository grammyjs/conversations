/**
 * Creates an object that throws an error when touched in any way. This includes
 *
 * - getting a property
 * - setting a property
 * - calling the object
 * - constructing the object
 *
 * and any of the other [object internal
 * methods](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy#object_internal_methods)
 * in JavaScript.
 *
 * @param msg An error message to use
 * @typeParam The type of object to create
 */
export function youTouchYouDie<T extends object>(msg: string) {
    function nope(): never {
        throw new Error(msg);
    }
    return new Proxy({} as T, {
        apply: nope,
        construct: nope,
        defineProperty: nope,
        deleteProperty: nope,
        get: nope,
        getOwnPropertyDescriptor: nope,
        getPrototypeOf: nope,
        has: nope,
        isExtensible: nope,
        ownKeys: nope,
        preventExtensions: nope,
        set: nope,
        setPrototypeOf: nope,
    });
}
