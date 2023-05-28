import { assertEquals } from "https://deno.land/std@0.177.1/testing/asserts.ts";
import { describe, it } from "https://deno.land/std@0.177.1/testing/bdd.ts";
import {
    assertSpyCall,
    spy,
} from "https://deno.land/std@0.177.1/testing/mock.ts";
import {
    chat,
    date,
    from,
    message_id,
    testConversation,
} from "./utils.test.ts";

describe("forms", () => {
    describe("text", () => {
        it("should return the message text", async () => {
            const text = "form test";
            assertEquals(
                text,
                await testConversation((c) =>
                    c.form.text(() => {
                        throw "never";
                    }), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text },
                }),
            );
            assertEquals(
                text,
                await testConversation((c) => c.form.text(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                        caption: text,
                    },
                }),
            );
        });

        it("should skip other updates", async () => {
            assertEquals(
                undefined,
                await testConversation((c) => c.form.text(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
        });

        it("should call the otherwise handler", async () => {
            const val = Math.random();
            const otherwise = spy(() => val);
            assertEquals(
                undefined,
                await testConversation((c) => c.form.text(otherwise), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
            assertSpyCall(otherwise, 0, { returned: val });
        });
    });

    describe("number", () => {
        it("should return the number in the message text", async () => {
            assertEquals(
                42.2,
                await testConversation((c) =>
                    c.form.number(() => {
                        throw "never";
                    }), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "42.2" },
                }),
            );
            assertEquals(
                42.2,
                await testConversation((c) =>
                    c.form.number(() => {
                        throw "never";
                    }), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "42.2xyz" },
                }),
            );
            assertEquals(
                42,
                await testConversation(
                    (c) => c.form.number(),
                    {
                        update_id: 20,
                        message: {
                            message_id,
                            chat,
                            from,
                            date,
                            document: { file_id: "abc", file_unique_id: "def" },
                            caption: "42",
                        },
                    },
                ),
            );
        });

        it("should skip other updates", async () => {
            assertEquals(
                undefined,
                await testConversation((c) => c.form.number(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        text: "not a number",
                    },
                }),
            );
            assertEquals(
                undefined,
                await testConversation((c) => c.form.number(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
        });

        it("should call the otherwise handler", async () => {
            const val = Math.random();
            const otherwise = spy(() => val);
            assertEquals(
                undefined,
                await testConversation((c) => c.form.number(otherwise), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
            assertSpyCall(otherwise, 0, { returned: val });
        });
    });

    describe("int", () => {
        it("should return the int in the message text", async () => {
            assertEquals(
                42,
                await testConversation((c) =>
                    c.form.int(() => {
                        throw "never";
                    }), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "42" },
                }),
            );
            assertEquals(
                2,
                await testConversation((c) => c.form.int(), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "2a" },
                }),
            );
            assertEquals(
                42,
                await testConversation((c) => c.form.int(16), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "2a" },
                }),
            );
            assertEquals(
                42,
                await testConversation((c) => c.form.int(), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "42.2" },
                }),
            );
            assertEquals(
                42,
                await testConversation(
                    (c) => c.form.int(),
                    {
                        update_id: 20,
                        message: {
                            message_id,
                            chat,
                            from,
                            date,
                            document: { file_id: "abc", file_unique_id: "def" },
                            caption: "42",
                        },
                    },
                ),
            );
        });

        it("should skip other updates", async () => {
            assertEquals(
                undefined,
                await testConversation((c) => c.form.int(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        text: "not an int",
                    },
                }),
            );
            assertEquals(
                undefined,
                await testConversation((c) => c.form.int(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
        });

        it("should call the otherwise handler", async () => {
            const val = Math.random();
            const otherwise = spy(() => val);
            assertEquals(
                undefined,
                await testConversation((c) => c.form.int(otherwise), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
            assertSpyCall(otherwise, 0, { returned: val });
        });
    });

    describe("select", () => {
        it("should return the selected option", async () => {
            assertEquals(
                "B",
                await testConversation(
                    (c) => c.form.select(["A", "a", "B", "b", "C", "c"]),
                    {
                        update_id: 20,
                        message: { message_id, chat, from, date, text: "B" },
                    },
                ),
            );
            assertEquals(
                "c",
                await testConversation(
                    (c) => c.form.select(["A", "a", "B", "b", "C", "c"]),
                    {
                        update_id: 20,
                        message: {
                            message_id,
                            chat,
                            from,
                            date,
                            document: { file_id: "abc", file_unique_id: "def" },
                            caption: "c",
                        },
                    },
                ),
            );
        });

        it("should skip other updates", async () => {
            assertEquals(
                undefined,
                await testConversation(
                    (c) => c.form.select(["A", "a", "B", "b", "C", "c"]),
                    {
                        update_id: 20,
                        message: {
                            message_id,
                            chat,
                            from,
                            date,
                            text: "d",
                        },
                    },
                ),
            );
            assertEquals(
                undefined,
                await testConversation(
                    (c) => c.form.select(["A", "a", "B", "b", "C", "c"]),
                    {
                        update_id: 20,
                        message: {
                            message_id,
                            chat,
                            from,
                            date,
                            document: { file_id: "abc", file_unique_id: "def" },
                        },
                    },
                ),
            );
        });

        it("should call the otherwise handler", async () => {
            const val = Math.random();
            const otherwise = spy(() => val);
            assertEquals(
                undefined,
                await testConversation(
                    (c) =>
                        c.form.select(
                            ["A", "a", "B", "b", "C", "c"],
                            otherwise,
                        ),
                    {
                        update_id: 20,
                        message: {
                            message_id,
                            chat,
                            from,
                            date,
                            document: { file_id: "abc", file_unique_id: "def" },
                        },
                    },
                ),
            );
            assertSpyCall(otherwise, 0, { returned: val });
        });
    });

    describe("url", () => {
        it("should return the parsed url", async () => {
            const url = "https://grammy.dev/";
            assertEquals(
                new URL(url),
                await testConversation((c) => c.form.url(), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: url },
                }),
            );
        });

        it("should skip other updates", async () => {
            assertEquals(
                undefined,
                await testConversation((c) => c.form.url(), {
                    update_id: 20,
                    message: { message_id, chat, from, date, text: "asdf" },
                }),
            );
            assertEquals(
                undefined,
                await testConversation((c) => c.form.url(), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
        });
        it("should call the otherwise handler", async () => {
            const val = Math.random();
            const otherwise = spy(() => val);
            assertEquals(
                undefined,
                await testConversation((c) => c.form.url(otherwise), {
                    update_id: 20,
                    message: {
                        message_id,
                        chat,
                        from,
                        date,
                        document: { file_id: "abc", file_unique_id: "def" },
                    },
                }),
            );
            assertSpyCall(otherwise, 0, { returned: val });
        });
    });
});
