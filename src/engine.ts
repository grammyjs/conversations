export interface ReplayControls {
    interrupt(): Promise<never>;
}
export type Builder<A extends unknown[], R> = (
    controls: ReplayControls,
    ...a: A
) => R | Promise<R>;

export interface ReplayResult<A extends unknown[], R> {
    state: ReplayState<A>;
    returned?: R;
}
export interface ReplayState<A extends unknown[]> {
    args: A;
}

export class ReplayEngine<A extends unknown[], R> {
    constructor(private readonly builder: Builder<A, R>) {}

    async play(args: A) {
        return await this.replay({ args });
    }
    async replay(state: ReplayState<A>): Promise<ReplayResult<A, R>> {
        return await replayFunc(this.builder, state);
    }
}

async function replayFunc<A extends unknown[], R>(
    builder: (controls: ReplayControls, ...args: A) => R | Promise<R>,
    state: ReplayState<A>,
): Promise<ReplayResult<A, R>> {
    function isReplaying() {}
    function interrupt() {
        return new Promise<never>(() => {});
    }
    function op() {}
    function checkPoint() {}
    function rewind() {}
    // etc

    const controls: ReplayControls = { interrupt };
    const r = await builder(controls, ...state.args);
    return { returned: r, state };
}
