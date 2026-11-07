/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { ipcMain, shell } from "electron";
import { mkdirSync } from "fs";
import { join } from "path";

import { DATA_DIR, IS_VANILLA } from "../utils/constants";
import { compilePlugin, scanUserPlugins, UserPluginBundle } from "./compile";
import {
    installUserPluginFromGit,
    listUserPluginEntries,
    removeUserPlugin,
    revealUserPlugin,
    updateUserPluginFromGit
} from "./manage";

export const USER_PLUGINS_DIR = join(DATA_DIR, "userplugins");

export interface UserPluginPayload {
    bundles: UserPluginBundle[];
    errors: Record<string, string>;
}

export function compileUserPlugins(): UserPluginPayload {
    const payload: UserPluginPayload = { bundles: [], errors: {} };
    if (IS_VANILLA) return payload;

    for (const plugin of scanUserPlugins(USER_PLUGINS_DIR)) {
        try {
            const bundle = compilePlugin(plugin.dir, plugin.entry, plugin.name, { bundlePackages: true });
            bundle.hasNative = !!plugin.native;
            payload.bundles.push(bundle);
        } catch (e) {
            payload.errors[plugin.name] = e instanceof Error ? e.message : String(e);
        }
    }
    return payload;
}

mkdirSync(USER_PLUGINS_DIR, { recursive: true });

ipcMain.on(IpcEvents.GET_USER_PLUGINS, e => {
    e.returnValue = compileUserPlugins();
});
ipcMain.handle(IpcEvents.OPEN_USER_PLUGINS_FOLDER, () => shell.openPath(USER_PLUGINS_DIR));
ipcMain.handle(IpcEvents.LIST_USER_PLUGIN_ENTRIES, () => listUserPluginEntries(USER_PLUGINS_DIR));
ipcMain.handle(IpcEvents.REVEAL_USER_PLUGIN, (_, dir: string) => revealUserPlugin(USER_PLUGINS_DIR, dir));
ipcMain.handle(IpcEvents.REMOVE_USER_PLUGIN, (_, dir: string) => removeUserPlugin(USER_PLUGINS_DIR, dir));
ipcMain.handle(IpcEvents.INSTALL_USER_PLUGIN_FROM_GIT, (_, url: string) => installUserPluginFromGit(USER_PLUGINS_DIR, String(url)));
ipcMain.handle(IpcEvents.UPDATE_USER_PLUGIN_FROM_GIT, (_, dir: string) => updateUserPluginFromGit(USER_PLUGINS_DIR, dir));
