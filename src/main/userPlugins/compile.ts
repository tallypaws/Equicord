/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { builtinModules, createRequire } from "module";
import { basename, dirname, extname, join, relative, resolve, sep } from "path";
import { transform } from "sucrase";

export interface UserPluginBundle {
    name: string;
    dir: string;
    hash: string;
    entry: string;
    modules: Record<string, string>;
    /** importer key -> specifier -> module key. Anything not listed here is looked up in the client itself. */
    deps: Record<string, Record<string, string>>;
    hasNative: boolean;
}

const NameMatcher = /definePlugin\(\{\s*(["'])?name\1:\s*(["'`])(.+?)\2/;
const RequireMatcher = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
const Extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const HostAliases = /^(@(api|utils|components|webpack|shared|main|plugins|equicordplugins|debug)(\/|$)|@vencord\/discord-types|~)/;

function getTarget(fileName: string) {
    const parts = fileName.replace(/\.tsx?$/, "").split(".");
    return parts.length === 1 ? null : parts.at(-1)!;
}

export function isTargetExcluded(target: string | null) {
    if (!target || IS_REPORTER) return false;
    const kind = IS_DISCORD_DESKTOP ? "discordDesktop" : "equibop";
    return (
        (target === "dev" && !IS_DEV) ||
        (target === "web" && kind === "discordDesktop") ||
        (target === "browser") ||
        (target === "discordDesktop" && kind !== "discordDesktop") ||
        (target === "vesktop" && kind !== "equibop") ||
        (target === "equibop" && kind !== "equibop")
    );
}

function tryFile(base: string) {
    const withoutJs = base.replace(/\.(m?js|cjs)$/, "");
    const candidates = [
        base,
        ...Extensions.map(e => base + e),
        ...Extensions.map(e => join(base, "index" + e)),
        ...(withoutJs !== base ? Extensions.map(e => withoutJs + e) : [])
    ];
    return candidates.find(c => existsSync(c) && statSync(c).isFile());
}

function compileSource(path: string, source: string) {
    const ext = extname(path);
    if (ext === ".json") return `module.exports = ${source};`;

    const transforms: Array<"typescript" | "jsx" | "imports"> = ["imports"];
    if (ext === ".ts" || ext === ".tsx") transforms.unshift("typescript");
    if (ext === ".tsx" || ext === ".jsx") transforms.unshift("jsx");

    return transform(source, {
        transforms,
        filePath: path,
        production: true,
        jsxPragma: "VencordCreateElement",
        jsxFragmentPragma: "VencordFragment",
        disableESTransforms: true
    }).code;
}

const styleDecl = (name: string, css: string) =>
    `(window.VencordStyles ??= new Map()).set(${JSON.stringify(name)},{name:${JSON.stringify(name)},source:${JSON.stringify(css)},classNames:{},dom:null});module.exports={__esModule:true,default:${JSON.stringify(name)}};`;

// esbuild collects plain css imports into a global stylesheet, so do the same with a style tag
const globalStyle = (pluginName: string, css: string) =>
    `const s=document.createElement("style");s.dataset.userPlugin=${JSON.stringify(pluginName)};s.textContent=${JSON.stringify(css)};document.head.append(s);module.exports={};`;

function fileUriModule(path: string, params: URLSearchParams) {
    const base64 = params.has("base64");
    let content = readFileSync(path, base64 ? "base64" : "utf-8");
    if (!base64 && params.get("trim") !== "false") content = content.trimEnd();
    return `module.exports={__esModule:true,default:${JSON.stringify(content)}};`;
}

export interface CompileOptions {
    /** Renderer: pull bare imports out of the plugin's node_modules. Natives resolve those with real node at runtime. */
    bundlePackages: boolean;
}

export function compilePlugin(pluginDir: string, entryFile: string, name: string, { bundlePackages }: CompileOptions): UserPluginBundle {
    const root = statSync(pluginDir).isDirectory() ? pluginDir : dirname(pluginDir);
    const modules: Record<string, string> = {};
    const deps: Record<string, Record<string, string>> = {};
    const hash = createHash("sha1");
    const queue = [entryFile];
    const key = (p: string) => relative(root, p).split(sep).join("/");

    while (queue.length) {
        const path = queue.pop()!;
        if (key(path) in modules) continue;

        const source = readFileSync(path, "utf-8");
        hash.update(key(path)).update(source);
        modules[key(path)] = compileSource(path, source);

        for (const [, , spec] of modules[key(path)].matchAll(RequireMatcher)) {
            const [rawPath, query = ""] = spec.replace(/^file:\/\//, "").split("?");
            const resolved = resolve(dirname(path), rawPath);

            if (spec.startsWith("file://")) {
                const params = new URLSearchParams(query);
                hash.update(readFileSync(resolved));
                const target = `${key(resolved)}?${query}`;
                deps[key(path)] = { ...deps[key(path)], [spec]: target };
                modules[target] = fileUriModule(resolved, params);
            } else if (rawPath.endsWith(".css") && (spec.startsWith(".") || query === "managed")) {
                const css = readFileSync(resolved, "utf-8");
                hash.update(css);
                const target = key(resolved) + (query ? `?${query}` : "");
                deps[key(path)] = { ...deps[key(path)], [spec]: target };
                modules[target] = query === "managed"
                    ? styleDecl(`userplugins/${basename(root)}/${key(resolved)}`, css)
                    : globalStyle(name, css);
            } else if (spec.startsWith(".")) {
                const file = tryFile(resolve(dirname(path), spec));
                if (!file) throw new Error(`Cannot resolve "${spec}" imported from ${key(path)}`);
                deps[key(path)] = { ...deps[key(path)], [spec]: key(file) };
                queue.push(file);
            } else if (bundlePackages && !HostAliases.test(spec) && !builtinModules.includes(spec.replace(/^node:/, ""))) {
                try {
                    const file = createRequire(path).resolve(spec);
                    deps[key(path)] = { ...deps[key(path)], [spec]: key(file) };
                    queue.push(file);
                } catch {
                    // not vendored with the plugin, the client may still expose it
                }
            }
        }
    }

    return {
        name,
        dir: basename(root),
        hash: hash.digest("hex"),
        entry: key(entryFile),
        modules,
        deps,
        hasNative: false
    };
}

export interface FoundPlugin {
    dir: string;
    entry: string;
    name: string;
    native?: string;
}

export function scanUserPlugins(userPluginsDir: string) {
    if (!existsSync(userPluginsDir)) return [];

    const found: FoundPlugin[] = [];
    for (const dirent of readdirSync(userPluginsDir, { withFileTypes: true })) {
        const fileName = dirent.name;
        if (fileName.startsWith("_") || fileName.startsWith(".") || fileName === "index.ts") continue;
        if (/\.(zip|rar|7z|tar|gz|bz2)/.test(fileName)) continue;
        if (isTargetExcluded(getTarget(fileName))) continue;

        const full = join(userPluginsDir, fileName);
        const entry = dirent.isFile()
            ? full
            : ["index.ts", "index.tsx"].map(f => join(full, f)).find(existsSync);
        if (!entry) continue;

        const name = NameMatcher.exec(readFileSync(entry, "utf-8"))?.[3];
        if (!name) continue;

        const native = dirent.isDirectory()
            ? ["native.ts", "native/index.ts"].map(f => join(full, f)).find(existsSync)
            : undefined;

        found.push({ dir: full, entry, name, native });
    }
    return found;
}
