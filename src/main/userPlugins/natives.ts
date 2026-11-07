/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { evaluateBundle } from "@utils/userPluginRuntime";
import { createRequire } from "module";
import MainHostModules from "~mainHostModules";

import { compilePlugin, scanUserPlugins } from "./compile";
import { USER_PLUGINS_DIR } from "./index";

type NativeMethods = Record<string, (...args: any[]) => unknown>;

/**
 * Runs native.ts of every user plugin inside the main process.
 * Imports of node builtins, electron and packages installed next to the plugin resolve through real node.
 * Unlike the renderer half these are only read on startup, because the preload script builds its method table once.
 */
export function loadUserNatives() {
    const natives: Record<string, NativeMethods> = {};

    for (const { name, native } of scanUserPlugins(USER_PLUGINS_DIR)) {
        if (!native) continue;

        try {
            const bundle = compilePlugin(native, native, name, { bundlePackages: false });
            const nodeRequire = createRequire(native);
            const exports = evaluateBundle(
                bundle,
                spec => MainHostModules[spec]?.(),
                { IS_DEV, IS_DISCORD_DESKTOP, IS_VESKTOP, IS_EQUIBOP, IS_STANDALONE, IS_UPDATER_DISABLED, IS_REPORTER, VERSION, BUILD_TIMESTAMP },
                nodeRequire
            );

            natives[name] = Object.fromEntries(
                Object.entries(exports).filter(([, v]) => typeof v === "function")
            ) as NativeMethods;
        } catch (e) {
            console.error(`[Equicord] Failed to load native of user plugin ${name}`, e);
        }
    }

    return natives;
}
