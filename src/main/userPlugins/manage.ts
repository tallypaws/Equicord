/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";
import { BrowserWindow, dialog, shell } from "electron";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import { ensureSafePath } from "../utils/ensureSafePath";
import { scanUserPlugins } from "./compile";

const run = promisify(execFile);

// Same hosts the userplugin installer accepts. Anything else has to be placed in the folder by hand.
const CLONE_URL = /^https:\/\/(?:github\.com|gitlab\.com|codeberg\.org|git\.(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]+)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/;

export interface UserPluginEntry {
    /** File or folder name inside the userplugins folder */
    dir: string;
    kind: "file" | "folder";
    /** Plugin name from definePlugin, absent when the entry does not look like a plugin */
    name?: string;
    hasNative: boolean;
    /** Remote url of the git checkout, if the folder is one */
    gitRemote?: string;
}

export interface UserPluginOpResult {
    ok: boolean;
    message?: string;
}

function getGitRemote(dir: string) {
    try {
        const config = readFileSync(join(dir, ".git", "config"), "utf-8");
        return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    } catch {
        return undefined;
    }
}

export function listUserPluginEntries(root: string): UserPluginEntry[] {
    if (!existsSync(root)) return [];

    const valid = new Map(scanUserPlugins(root).map(p => [p.dir, p]));
    const entries: UserPluginEntry[] = [];

    for (const dirent of readdirSync(root, { withFileTypes: true })) {
        const { name: dir } = dirent;
        if (dir.startsWith(".") || dir === "index.ts") continue;
        // Mirrors scanUserPlugins: underscore folders are intentionally ignored, archives are not plugins
        if (dir.startsWith("_") || /\.(zip|rar|7z|tar|gz|bz2)/.test(dir)) continue;

        const full = join(root, dir);
        const found = valid.get(full);
        entries.push({
            dir,
            kind: dirent.isDirectory() ? "folder" : "file",
            name: found?.name,
            hasNative: !!found?.native,
            gitRemote: dirent.isDirectory() ? getGitRemote(full) : undefined
        });
    }

    return entries;
}

function parent() {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function resolveEntry(root: string, dir: string) {
    if (!dir || dir.includes("/") || dir.includes("\\") || dir.startsWith(".")) return null;
    const path = ensureSafePath(root, dir);
    return path && path !== root && existsSync(path) ? path : null;
}

export function revealUserPlugin(root: string, dir: string) {
    const path = resolveEntry(root, dir);
    if (path) shell.showItemInFolder(path);
}

export async function removeUserPlugin(root: string, dir: string): Promise<UserPluginOpResult> {
    const path = resolveEntry(root, dir);
    if (!path) return { ok: false, message: "Plugin not found" };

    // Confirm in the main process so a compromised page cannot delete files silently
    const { response } = await dialog.showMessageBox(parent(), {
        type: "warning",
        title: "Remove user plugin",
        message: `Remove ${dir}?`,
        detail: `This permanently deletes ${path} from disk.`,
        buttons: ["Cancel", "Remove"],
        defaultId: 0,
        cancelId: 0
    });
    if (response !== 1) return { ok: false, message: "Cancelled" };

    try {
        await rm(path, { recursive: true, force: true });
        return { ok: true };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
}

export async function installUserPluginFromGit(root: string, url: string): Promise<UserPluginOpResult> {
    const match = CLONE_URL.exec(url.trim());
    if (!match) {
        return {
            ok: false,
            message: "Only https links to GitHub, GitLab, Codeberg or git.* hosts are supported. Put other plugins into the folder manually."
        };
    }

    const [, owner, repo] = match;
    if (repo === "." || repo === ".." || owner === "." || owner === "..")
        return { ok: false, message: "Invalid repository link" };

    const target = ensureSafePath(root, repo);
    if (!target || target === root) return { ok: false, message: "Invalid repository name" };
    if (existsSync(target)) return { ok: false, message: `A plugin folder named ${repo} already exists` };

    const cloneUrl = `https://${new URL(url.trim()).host}/${owner}/${repo}.git`;
    const { response } = await dialog.showMessageBox(parent(), {
        type: "question",
        title: "Install user plugin",
        message: `Install ${repo} by ${owner}?`,
        detail: `${cloneUrl}\n\nUser plugins run with full access to Discord and your account. Equicord does not review them. Only continue if you trust the author.`,
        buttons: ["Cancel", "Install"],
        defaultId: 0,
        cancelId: 0
    });
    if (response !== 1) return { ok: false, message: "Cancelled" };

    try {
        await run("git", ["clone", "--depth", "1", "--", cloneUrl, target], { timeout: 120_000, windowsHide: true });
    } catch (e: any) {
        await rm(target, { recursive: true, force: true }).catch(() => { });
        return {
            ok: false,
            message: e?.code === "ENOENT"
                ? "Git is not installed or not in your PATH"
                : (e?.stderr || e?.message || "git clone failed").toString().trim()
        };
    }

    // Nothing for the loader to pick up, so tell the user instead of leaving a dead folder around
    const loadable = scanUserPlugins(root).some(p => p.dir === target);
    return loadable
        ? { ok: true }
        : { ok: true, message: `Cloned ${repo}, but it has no index.ts(x) with a definePlugin({ name }) call, so it will not load.` };
}

export async function updateUserPluginFromGit(root: string, dir: string): Promise<UserPluginOpResult> {
    const path = resolveEntry(root, dir);
    if (!path || !statSync(path).isDirectory() || !existsSync(join(path, ".git")))
        return { ok: false, message: "This plugin is not a git checkout" };

    try {
        const { stdout } = await run("git", ["pull", "--ff-only"], { cwd: path, timeout: 120_000, windowsHide: true });
        return { ok: true, message: stdout.toString().trim() };
    } catch (e: any) {
        return {
            ok: false,
            message: e?.code === "ENOENT"
                ? "Git is not installed or not in your PATH"
                : (e?.stderr || e?.message || "git pull failed").toString().trim()
        };
    }
}
