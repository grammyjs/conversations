import {
    type Api,
    type ApiResponse,
    Context,
    type Middleware,
    type RawApi,
    type SessionFlavor,
    type Update,
    type UserFromGetMe,
} from "./deps.deno.ts";

type ApiCallResult = Await<ReturnType<RawApi[keyof RawApi]>>;
type Await<T> = T extends PromiseLike<infer V> ? V : T;

function ident<T>(arg: T) {
    return arg;
}

class InterruptPromise extends Promise<void> {
    waiting = true;
    resolve = () => {/* dead code */};
    constructor() {
        super((resolve) =>
            this.resolve = () => {
                this.waiting = false;
                resolve();
            }
        );
    }
}

type ConversationBuilder<C extends Context> = (
    t: Conversation<C>,
    ctx: C,
) => unknown | Promise<unknown>;
export type ConversationFlavor<C extends Context> =
    & C
    & { conversation: ConversationControls<C> }
    & SessionFlavor<ConversationSessionData>;

const internal = Symbol("conversations");

interface ConversationControls<C extends Context> {
    [internal]: Map<string, ConversationBuilder<C>>;
    enter(id: string): void;
}

interface ConversationSessionData {
    conversation?: { activeId: string; log: OpLog };
}
interface OpLog {
    entries: OpLogEntry[];
}
interface OpLogEntry {
    op: WaitOp | ApiOp | ExtOp;
}
interface WaitOp {
    type: "wait";
    value: Update;
}
interface ApiOp {
    type: "api";
    value: ApiResponse<ApiCallResult>;
}
interface ExtOp {
    type: "ext";
    // deno-lint-ignore no-explicit-any
    value: any;
}

export function createConversation<C extends Context>(
    builder: ConversationBuilder<C>,
    id = builder.name,
): Middleware<ConversationFlavor<C>> {
    return async (ctx, next) => {
        // Define how to enter a conversation
        function enter(id: string) {
            const s = ctx.session;
            if (s.conversation !== undefined) {
                throw new Error(
                    `Already in conversation ${s.conversation.activeId}`,
                );
            } else {
                s.conversation = { activeId: id, log: { entries: [] } };
            }
        }

        // Define how to run a conversation
        async function run(log: OpLog, target = builder) {
            const onWait = new InterruptPromise();
            const conversation = new Conversation<C>(
                log,
                ctx.api,
                ctx.me,
                onWait,
            );
            await Promise.race([onWait, target(conversation, ctx)]);
            if (!onWait.waiting && ctx.session?.conversation !== undefined) {
                ctx.session.conversation = undefined;
            }
        }

        // Register conversation controls on context
        const first = ctx.conversation === undefined;
        if (first) ctx.conversation = { [internal]: new Map(), enter };

        // Add ourselves to conversation index
        const map = ctx.conversation[internal];
        if (map.has(id)) {
            throw new Error(`Duplicate conversation identifier ${id}!`);
        }
        map.set(id, builder);

        // Continue last conversation if required
        if (ctx.session?.conversation?.activeId === id) {
            const log = ctx.session.conversation.log;
            log.entries.push({ op: { type: "wait", value: ctx.update } });
            await run(log);
            return;
        }

        // No conversation running, call downstream middleware
        await next();

        // Run entered conversation if we are responsible
        if (first && ctx.session?.conversation !== undefined) {
            const { activeId, log } = ctx.session.conversation;
            await run(log, map.get(activeId));
        }
    };
}

class Conversation<C extends Context> {
    private op = 0;

    constructor(
        private readonly opLog: OpLog,
        private api: Api,
        private me: UserFromGetMe,
        private onWait: InterruptPromise,
    ) {
        api.config.use(async (prev, method, payload, signal) => {
            if (this.replaying) return this.replayOp("api");
            const response = await prev(method, payload, signal);
            this.logOp({ op: { type: "api", value: response } });
            return response;
        });
    }

    get replaying() {
        return this.op < this.opLog.entries.length;
    }
    private replayOp<T extends OpLogEntry["op"]["type"]>(expectedType: T) {
        if (!this.replaying) {
            // TODO: improve error message
            throw new Error("Replay stack exhaustet!");
        }
        const { op } = this.opLog.entries[this.op];
        if (op.type !== expectedType) {
            // TODO: improve error message
            throw new Error(
                `Unexpected operation performed during replay (expected '${op.type}' but was '${expectedType}')!`,
            );
        }
        this.op++;
        switch (op.type) {
            case "wait":
                return new Context(op.value, this.api, this.me);
            case "api":
            case "ext":
                return op.value;
        }
    }
    logOp(op: OpLogEntry) {
        if (this.replaying) {
            console.warn("WARNING: Adding log entry while replaying!");
        } else {
            this.op++;
        }
        this.opLog.entries.push(op);
    }

    async wait(): Promise<C> {
        if (this.replaying) return this.replayOp("wait");
        this.onWait.resolve();
        await new Promise(() => {}); // intercept function execution
        // deno-lint-ignore no-explicit-any
        return 0 as any; // dead code
    }
    // deno-lint-ignore no-explicit-any
    async external<F extends (...args: any[]) => any, I = any>(
        op: {
            task: F;
            args?: Parameters<F>;
            preStringify?: (value: ReturnType<F>) => I | Promise<I>;
            postParse?: (value: I) => ReturnType<F>;
        },
    ): Promise<Awaited<ReturnType<F>>> {
        const { task, args = [], preStringify = ident, postParse = ident } = op;
        if (this.replaying) return await postParse(this.replayOp("ext"));
        const value = await task(...args);
        this.logOp({ op: { type: "ext", value: preStringify(value) } });
        return value;
    }
    async delay(milliseconds: number): Promise<void> {
        if (this.replaying) return;
        await new Promise((r) => setTimeout(r, milliseconds));
    }

    random() {
        return this.external({ task: () => Math.random() });
    }
}
