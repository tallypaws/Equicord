/*
 * Tallycord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { makeRange, OptionType } from "@utils/types";

import { UwuIcon, UwuIconFactory } from "./uwuicon";
import Uwuifier from "./uwuifier";
import { Devs, TallycordDevs } from "@utils/constants";

export const settings = definePluginSettings({
    faceChance: {
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 0.1,
        description: "Chance to insert faces into message",
    },
    stutterChance: {
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 0.4,
        description: "chance for stutters to happen",
    }, wordChance: {
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 1,
        description: "Chance to replace words or letters with their uwu counterpart",
    },
    exclamationChance: {
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 1,
        description: "chance for exclamations to be replaced",
    },
    faces: {
        type: OptionType.STRING,
        default: ";;w;;,OwO,UwU,>w<,^w^,ÚwÚ,^-^,:3,x3,",
        description: "faces to use, seperated by comma",
    },
    autoUwu: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "uwu"
    }
});
export default definePlugin({
    name: "Uwuify",
    description: "Uwuifies your messages on send!",
    authors: [TallycordDevs.tally],
    dependencies: ["MessageAccessoriesAPI", "MessagePopoverAPI", "MessageEventsAPI", "ChatInputButtonAPI"],
    source: "Tallycord",
    settings,


    start() {


        // addChatBarButton("vc-uwu", UwuChatBarIcon);


        this.preSend = addMessagePreSendListener(async (_, message) => {
            if (!message.content || !settings.store.autoUwu) return;
            const uwu = new Uwuifier();
            message.content = uwu.uwuifySentence(message.content);
        });
    },

    chatBarButton: {
        icon: UwuIcon,
        render: UwuIconFactory
    },

    stop() {
        removeMessagePreSendListener(this.preSend);
        // removeChatBarButton("vc-uwu");
    },
});
