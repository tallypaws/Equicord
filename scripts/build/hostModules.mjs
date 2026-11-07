/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// @ts-check

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import { join, relative, sep } from "path";
import { fileURLToPath } from "url";

const CODE_EXT = /\.(tsx?|jsx?|mjs)$/;

// alias -> directory. Everything below these is exposed to user plugins.
const FULL_ALIASES = {
    "@api": "src/api",
    "@utils": "src/utils",
    "@components": "src/components",
    "@shared": "src/shared",
    "@debug": "src/debug",
    "@webpack/common": "src/webpack/common",
    "@vencord/discord-types/enums": "packages/discord-types/enums"
};

// exact specifier -> file. Mirrors the "paths" in tsconfig.json
const FIXED = {
    "@webpack": "src/webpack/webpack.ts",
    "@webpack/patcher": "src/webpack/patchWebpack.ts",
    "@webpack/types": "src/webpack/types.ts"
};

// Type only specifiers. Sucrase elides these but if one survives it must not crash
const EMPTY = ["@vencord/discord-types", "@vencord/discord-types/webpack", "@webpack/wreq.d", "react", "react-dom", "type-fest"];

// Plugin to plugin imports. Only specifiers that are already imported somewhere are exposed, so these cost nothing
const PLUGIN_ALIASES = { "@plugins": "src/plugins", "@equicordplugins": "src/equicordplugins" };

// Packages the build bans direct imports of. The host exposes them through the module it tells plugins to use instead
const REROUTED = { "ts-pattern": "@webpack/common" };

const NODE_ONLY = new Set([...builtinModules, "electron", "original-fs"]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]
    );
}

/** @param {string} file */
function isNativeFile(file) {
    const parts = file.split(sep);
    return parts.at(-1)?.startsWith("native.") || parts.includes("native");
}

/** @param {string} file */
function stripExt(file) {
    return file.replace(CODE_EXT, "").split(sep).join("/");
}

/** @param {string} root @param {string} file */
function toSrcRelative(root, file) {
    const rel = stripExt(relative(join(root, "src"), file));
    return rel.startsWith("../") ? rel : "./" + rel;
}

/** @param {string} root @param {string} alias @param {string} dir @param {(file: string) => boolean} [filter] @param {boolean} [skipNatives] */
function addDir(root, map, alias, dir, filter = () => true, skipNatives = false) {
    for (const file of walk(join(root, dir))) {
        if (!CODE_EXT.test(file) || file.endsWith(".d.ts") || (skipNatives && isNativeFile(file)) || !filter(file)) continue;
        const rel = stripExt(relative(join(root, dir), file));
        map[`${alias}/${rel}`] = toSrcRelative(root, file);
        if (rel === "index" || rel.endsWith("/index")) {
            map[rel === "index" ? alias : `${alias}/${rel.slice(0, -"/index".length)}`] = map[`${alias}/${rel}`];
        }
    }
}

/**
 * Source specifiers that real code imports, for every module the build would bundle.
 * @param {string} root
 * @param {(folder: string) => boolean} isExcludedFolder
 */
function scanImports(root, isExcludedFolder) {
    const specs = new Set();
    // Whole statements, so `import type` / `export type` can be told apart. [^;"'] stops a match from running into the next statement
    const statement = /^[ \t]*(?:import|export)\s+(type\s+)?[^;"']*?from\s*["']([^"'\n]+)["']/gm;
    const sideEffect = /^[ \t]*import\s*["']([^"'\n]+)["']/gm;
    const dynamic = /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g;

    for (const dir of ["src/plugins", "src/equicordplugins", "src/api", "src/components", "src/utils", "src/webpack"]) {
        for (const file of walk(join(root, dir))) {
            if (!CODE_EXT.test(file) || file.endsWith(".d.ts") || isNativeFile(file) || isExcludedFolder(relative(root, file))) continue;

            const source = readFileSync(file, "utf-8");
            for (const m of source.matchAll(statement)) if (!m[1]) specs.add(m[2]);
            for (const m of source.matchAll(sideEffect)) specs.add(m[1]);
            for (const m of source.matchAll(dynamic)) specs.add(m[1]);
        }
    }
    return specs;
}

const isFile = p => existsSync(p) && statSync(p).isFile();
const LOADABLE = [".js", ".mjs", ".cjs", ".json", ".ts"];

/**
 * Whether esbuild would be able to load the package specifier. This file lives inside the repository, so resolution
 * starts from the repo's node_modules. import.meta.resolve alone only proves the package exists, not that the
 * subpath does, so the target is checked the way esbuild would load it.
 * The scan above is a heuristic, and one specifier that fails would otherwise break the whole build.
 * @param {string} spec
 */
function canResolve(spec) {
    let path;
    try {
        path = fileURLToPath(import.meta.resolve(spec));
    } catch {
        return false;
    }

    if (isFile(path) || LOADABLE.some(ext => isFile(path + ext))) return true;
    if (!existsSync(path) || !statSync(path).isDirectory()) return false;
    return isFile(join(path, "package.json")) || LOADABLE.some(ext => isFile(join(path, "index" + ext)));
}

/**
 * Build the specifier -> source file map that user plugins can import from the running client.
 * Values are paths relative to ./src as esbuild's resolveDir
 * @param {string} root repository root
 * @param {(folder: string) => boolean} isExcludedFolder
 */
export function collectHostModules(root, isExcludedFolder = () => false) {
    /** @type {Record<string, string>} */
    const files = {};
    /** @type {Record<string, string>} */
    const relMap = {};

    for (const [alias, dir] of Object.entries(FULL_ALIASES)) addDir(root, relMap, alias, dir);
    for (const [spec, file] of Object.entries(FIXED)) relMap[spec] = toSrcRelative(root, join(root, file));

    const imported = scanImports(root, isExcludedFolder);

    for (const [alias, dir] of Object.entries(PLUGIN_ALIASES)) {
        const wanted = new Set([...imported].filter(s => s === alias || s.startsWith(alias + "/")));
        const pool = {};
        addDir(root, pool, alias, dir, f => !isExcludedFolder(relative(root, f)), true);
        for (const spec of wanted) if (pool[spec]) relMap[spec] = pool[spec];
    }

    const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const declared = new Set(Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }));
    const packages = [...imported].filter(s => {
        if (!/^(@[a-z0-9-]+\/)?[a-z0-9._-]+(\/[\w./-]+)?$/.test(s) || EMPTY.includes(s) || NODE_ONLY.has(s) || s.startsWith("@vencord/") || s in REROUTED) return false;
        const name = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
        return declared.has(name) && canResolve(s);
    });

    for (const [spec, file] of Object.entries(relMap)) files[spec] = file;
    return { files, packages, empty: EMPTY, rerouted: REROUTED };
}

/**
 * Build the code of the ~hostModules virtual module.
 *
 * Every entry is a lazy require() instead of an import. esbuild turns the required module into an on demand
 * initializer, so nothing in this map runs at startup. Modules the client already imports still run when
 * they always did, and are shared with user plugins, but modules with side effects at top level
 * (main/patcher.ts reads the host's app.asar) only run if something asks for them.
 * @param {ReturnType<typeof collectHostModules>} mods
 */
export function generateHostModulesCode(mods) {
    const thunk = spec => `()=>require(${JSON.stringify(spec)})`;
    let table = "";

    for (const [spec, path] of Object.entries(mods.files)) table += `${JSON.stringify(spec)}:${thunk(path)},\n`;
    for (const pkg of mods.packages) table += `${JSON.stringify(pkg)}:${thunk(pkg)},\n`;
    for (const [spec, target] of Object.entries(mods.rerouted))
        if (mods.files[target]) table += `${JSON.stringify(spec)}:${thunk(mods.files[target])},\n`;
    for (const spec of mods.empty) table += `${JSON.stringify(spec)}:()=>({}),\n`;

    return `export default {\n${table}};`;
}

/**
 * Same as collectHostModules for the main process, which only natives of user plugins run in.
 * @param {string} root repository root
 */
export function collectMainHostModules(root) {
    /** @type {Record<string, string>} */
    const files = {};
    addDir(root, files, "@main", "src/main", f => !/src[\\/]main[\\/]index\.ts$/.test(f));
    addDir(root, files, "@shared", "src/shared");
    delete files["@main"];
    return { files, packages: [], empty: ["@vencord/discord-types"], rerouted: {} };
}
