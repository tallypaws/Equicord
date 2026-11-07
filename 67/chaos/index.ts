import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Devs, TallycordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

function randomUnicodeString(length: number) {
    const ranges = [
        [0x0021, 0x007E], // normal chars
        [0x00A1, 0x024F], // latin
        [0x0370, 0x03FF], // greek
        [0x0400, 0x04FF], //christler (cryllic)
        [0x2000, 0x206F], // punctuaion
        [0x2100, 0x214F], // letterlike
        [0x2190, 0x21FF], // arrows
        [0x2200, 0x22FF], // math shit
        [0x2500, 0x257F], // box
        [0x2580, 0x259F], // block
        [0x25A0, 0x25FF], // SHAPES
        [0x2600, 0x26FF], // misc
    ];

    let result = "";

    for (let i = 0; i < length; i++) {
        const [min, max] = ranges[Math.floor(Math.random() * ranges.length)];
        const code = min + Math.floor(Math.random() * (max - min + 1));
        result += String.fromCodePoint(code);
    }

    return result;
}

export default definePlugin({
    name: "chaos",
    description: " ▆♂◚Ì⚰",
    authors: [TallycordDevs.tally],
    dependencies: ["MessageAccessoriesAPI", "MessagePopoverAPI", "MessageEventsAPI", "ChatInputButtonAPI"],
    source: "Tallycord",

    start() {
        this.preSend = addMessagePreSendListener(async (_, message) => {
            if (!message.content) return;

            // Match chaos 3
            message.content = message.content.replace(/chaos (\d+)/g, (_, number) => {
                const n = Number(number);

                return randomUnicodeString(n);
            });
        });
    },

    stop() {
        removeMessagePreSendListener(this.preSend);
    },
});
