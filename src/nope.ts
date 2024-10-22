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
