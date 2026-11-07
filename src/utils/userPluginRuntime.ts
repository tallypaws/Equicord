/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface UserPluginBundle {
    name: string;
    dir: string;
    hash: string;
    entry: string;
    modules: Record<string, string>;
    deps: Record<string, Record<string, string>>;
    hasNative: boolean;
}

type Exports = Record<string, unknown>;
type HostLookup = (spec: string) => Exports | undefined;

// Compiled imports only treat a module as ESM when `__esModule` is set. The proxy keeps host exports live.
const interopCache = new WeakMap<object, Exports>();
function toInterop(ns: Exports) {
    let wrapped = interopCache.get(ns);
    if (!wrapped) interopCache.set(ns, wrapped = new Proxy(ns, {
        get: (target, key) => key === "__esModule" ? true : Reflect.get(target, key)
    }));
    return wrapped;
}

export function evaluateBundle(
    bundle: UserPluginBundle,
    hostLookup: HostLookup,
    globals: Record<string, unknown>,
    fallbackRequire?: (spec: string) => unknown
) {
    const cache: Record<string, { exports: Exports; }> = {};
    const globalNames = Object.keys(globals);
    const globalValues = Object.values(globals);

    const load = (key: string) => {
        const cached = cache[key];
        if (cached) return cached.exports;

        const module = cache[key] = { exports: {} as Exports };
        const fn = new Function(
            "exports", "require", "module", "__filename", ...globalNames,
            `${bundle.modules[key]}\n//# sourceURL=vencord-userplugin://${bundle.name}/${key}`
        );
        fn(module.exports, (spec: string) => requireFrom(key, spec), module, key, ...globalValues);
        return module.exports;
    };

    const requireFrom = (from: string, spec: string): unknown => {
        const target = bundle.deps[from]?.[spec];
        if (target) return load(target);

        const host = hostLookup(spec) ?? hostLookup(spec.replace(/\.(m?js)$/, ""));
        if (host) return toInterop(host);
        if (fallbackRequire) return fallbackRequire(spec);

        throw new Error(
            `Cannot find module "${spec}" imported from ${from}. ` +
            "It is not exposed by this build of the client and is not bundled with the plugin."
        );
    };

    return load(bundle.entry);
}
