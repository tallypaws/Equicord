/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings, SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { Plugin } from "@utils/types";
import { evaluateBundle, UserPluginBundle } from "@utils/userPluginRuntime";
import { React } from "@webpack/common";
import gitHash from "~git-hash";
import gitRemote from "~git-remote";
import HostModules from "~hostModules";
import Plugins, * as PluginsModule from "~plugins";
import { PluginMeta } from "~plugins";

import { isPluginEnabled, startPlugin, stopPlugin } from "./PluginManager";

const logger = new Logger("UserPlugins", "#ca9ee6");

const loaded = new Map<string, UserPluginBundle>();
const listeners = new Set<() => void>();

export const userPluginErrors: Record<string, string> = {};
export const onUserPluginsChanged = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));

const virtualModules: Record<string, Record<string, unknown>> = {
    "~plugins": PluginsModule as Record<string, unknown>,
    "~git-hash": { default: gitHash },
    "~git-remote": { default: gitRemote }
};

const lookupHost = (spec: string) => virtualModules[spec] ?? HostModules[spec]?.();

// Build constants are inlined by esbuild in the host but user plugins are compiled at runtime, so hand them over as variables
function getGlobals() {
    return {
        VencordCreateElement: (...args: Parameters<typeof React.createElement>) => React.createElement(...args),
        VencordFragment: Symbol.for("react.fragment"),
        IS_WEB, IS_EXTENSION, IS_USERSCRIPT, IS_STANDALONE, IS_UPDATER_DISABLED, IS_DEV, IS_REPORTER,
        IS_COMPANION_TEST, IS_ANTI_CRASH_TEST, IS_DISCORD_DESKTOP, IS_VESKTOP, IS_EQUIBOP,
        VERSION, BUILD_TIMESTAMP
    };
}

function register(bundle: UserPluginBundle) {
    try {
        const plugin = (evaluateBundle(bundle, lookupHost, getGlobals()) as { default: Plugin; }).default;
        if (!plugin?.name) throw new Error("Plugin has no default export created with definePlugin");

        if (plugin.name in Plugins && !PluginMeta[plugin.name]?.userPlugin)
            throw new Error(`A built in plugin named ${plugin.name} already exists`);

        Plugins[plugin.name] = plugin;
        PluginMeta[plugin.name] = { folderName: bundle.dir, userPlugin: true };
        loaded.set(plugin.name, bundle);
        delete userPluginErrors[bundle.name];
        return plugin;
    } catch (e) {
        userPluginErrors[bundle.name] = e instanceof Error ? e.message : String(e);
        logger.error(`Failed to load user plugin ${bundle.name}\n`, e);
    }
}

// What initPluginManager does for every plugin, for plugins that arrive after it ran
function prepare(plugin: Plugin) {
    for (const dep of plugin.dependencies ?? []) {
        if (!Plugins[dep]) continue;
        Settings.plugins[dep].enabled = true;
        Plugins[dep].isDependency = true;
    }

    if (plugin.settings) {
        plugin.settings.pluginName = plugin.name;
        for (const [key, def] of Object.entries(plugin.settings.def))
            if (def.onChange) SettingsStore.addChangeListener(`plugins.${plugin.name}.${key}`, def.onChange);
    }
}

/** Must run synchronously before initPluginManager so patches of enabled plugins are registered in time. */
export function loadUserPlugins() {
    if (IS_WEB) return;

    const { bundles, errors } = VencordNative.userPlugins.getBundles();
    Object.assign(userPluginErrors, errors);
    for (const bundle of bundles) register(bundle);
}

export function unloadUserPlugin(name: string) {
    const plugin = Plugins[name];
    if (plugin?.started) stopPlugin(plugin);

    document.querySelectorAll(`style[data-user-plugin="${CSS.escape(name)}"]`).forEach(s => s.remove());
    delete Plugins[name];
    delete PluginMeta[name];
    loaded.delete(name);
}

/**
 * Apply changes on disk while Discord is running. Returns the plugins that need a restart,
 * which is every plugin that touches webpack patches, since those cannot be taken back.
 */
export function reloadUserPlugins() {
    const { bundles, errors } = VencordNative.userPlugins.getBundles();
    Object.assign(userPluginErrors, errors);

    const needRestart: string[] = [];
    const incoming = new Map(bundles.map(b => [b.name, b]));

    for (const [name, old] of loaded) {
        const next = incoming.get(name);
        if (next?.hash === old.hash) continue;

        if (Plugins[name].patches?.length) needRestart.push(name);
        else unloadUserPlugin(name);
    }

    for (const [name, bundle] of incoming) {
        if (loaded.has(name)) continue;

        const plugin = register(bundle);
        if (!plugin) continue;

        prepare(plugin);
        if (plugin.patches?.length) needRestart.push(name);
        else if (isPluginEnabled(name)) startPlugin(plugin);
    }

    listeners.forEach(cb => cb());
    return needRestart;
}
