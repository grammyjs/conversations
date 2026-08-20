import { type Update } from "./deps.deno.ts";

export function cloneUpdate(update: Update): Update {
    return JSON.parse(JSON.stringify(update)) as Update;
}
