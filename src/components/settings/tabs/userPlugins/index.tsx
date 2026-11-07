/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings, useSettings } from "@api/Settings";
import { onUserPluginsChanged, reloadUserPlugins, userPluginErrors } from "@api/UserPlugins";
import { Badge } from "@components/Badge";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { DeleteIcon, FolderIcon, PlusIcon, RestartIcon } from "@components/Icons";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { QuickAction, QuickActionCard } from "@components/settings";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { Switch } from "@components/Switch";
import type { UserPluginEntry, UserPluginOpResult } from "@main/userPlugins/manage";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { relaunch } from "@utils/native";
import { React, Select, showToast, TextInput, Toasts, useEffect, useMemo, useState } from "@webpack/common";

import Plugins, { PluginMeta } from "~plugins";

const cl = classNameFactory("vc-user-plugins-");

type Filter = "all" | "enabled" | "disabled" | "problems";

const filterOptions: { label: string; value: Filter; }[] = [
    { label: "Show All", value: "all" },
    { label: "Enabled", value: "enabled" },
    { label: "Disabled", value: "disabled" },
    { label: "Problems", value: "problems" }
];

function describeStatus(entry: UserPluginEntry) {
    const key = entry.name ?? entry.dir;
    const error = userPluginErrors[key];
    const plugin = entry.name && PluginMeta[entry.name]?.userPlugin ? Plugins[entry.name] : undefined;
    return { error, plugin };
}

function useEntries() {
    const [entries, setEntries] = useState<UserPluginEntry[] | null>(null);
    const [, bump] = useState(0);

    const refresh = React.useCallback(async () => {
        try {
            setEntries(await VencordNative.userPlugins.listEntries());
        } catch (e) {
            showToast("Failed to read the userplugins folder", Toasts.Type.FAILURE);
            setEntries(prev => prev ?? []);
        }
        bump(n => n + 1);
    }, []);

    useEffect(() => {
        refresh();
        // reloadUserPlugins notifies after every change on disk
        const off = onUserPluginsChanged(refresh);
        return () => void off();
    }, [refresh]);

    return [entries, refresh] as const;
}

function UserPluginsTab() {
    useSettings(["plugins.*"]);

    const [entries, refresh] = useEntries();
    const [restartNeeded, setRestartNeeded] = useState<string[]>([]);
    const [gitUrl, setGitUrl] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<Filter>("all");

    const markRestart = (name: string) =>
        setRestartNeeded(prev => prev.includes(name) ? prev : [...prev, name]);

    function applyDiskChanges() {
        const needRestart = reloadUserPlugins();
        needRestart.forEach(markRestart);
    }

    async function runOp(id: string, op: () => Promise<UserPluginOpResult>, success: string) {
        setBusy(id);
        try {
            const res = await op();
            if (res.ok) {
                showToast(res.message || success, Toasts.Type.SUCCESS);
                applyDiskChanges();
            } else if (res.message && res.message !== "Cancelled") {
                showToast(res.message, Toasts.Type.FAILURE);
            }
            return res.ok;
        } catch (e) {
            showToast(e instanceof Error ? e.message : String(e), Toasts.Type.FAILURE);
            return false;
        } finally {
            setBusy(null);
            refresh();
        }
    }

    async function install() {
        const url = gitUrl.trim();
        if (!url) return;
        if (await runOp("install", () => VencordNative.userPlugins.installFromGit(url), "Plugin installed")) setGitUrl("");
    }

    function toggle(name: string) {
        const plugin = Plugins[name];
        if (!plugin) return;

        const settings = Settings.plugins[name];
        const wasEnabled = isPluginEnabled(name);

        if (!wasEnabled) {
            const { restartNeeded: depsNeedRestart, failures } = startDependenciesRecursive(plugin);
            if (failures.length) {
                showToast(`Failed to start dependencies: ${failures.join(", ")}`, Toasts.Type.FAILURE);
                return;
            }
            if (depsNeedRestart) {
                settings.enabled = true;
                markRestart(name);
                return;
            }
        }

        if (pluginRequiresRestart(plugin)) {
            settings.enabled = !wasEnabled;
            markRestart(name);
            return;
        }

        if (wasEnabled && !plugin.started) {
            settings.enabled = false;
            return;
        }

        if (!(wasEnabled ? stopPlugin(plugin) : startPlugin(plugin))) {
            settings.enabled = false;
            showToast(`Error while ${wasEnabled ? "stopping" : "starting"} ${name}`, Toasts.Type.FAILURE);
            return;
        }

        settings.enabled = !wasEnabled;
    }

    const rows = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (entries ?? [])
            .map(entry => ({ entry, ...describeStatus(entry) }))
            .filter(({ entry, error, plugin }) => {
                const label = (entry.name ?? entry.dir).toLowerCase();
                if (q && !label.includes(q) && !entry.dir.toLowerCase().includes(q)) return false;

                const problem = !!error || !entry.name;
                switch (filter) {
                    case "enabled": return !!entry.name && isPluginEnabled(entry.name);
                    case "disabled": return !!plugin && !isPluginEnabled(entry.name!);
                    case "problems": return problem;
                    default: return true;
                }
            })
            .sort((a, b) => (a.entry.name ?? a.entry.dir).localeCompare(b.entry.name ?? b.entry.dir));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entries, search, filter, restartNeeded, busy]);

    const total = entries?.length ?? 0;
    const problems = (entries ?? []).filter(e => userPluginErrors[e.name ?? e.dir] || !e.name).length;
    const enabled = (entries ?? []).filter(e => e.name && PluginMeta[e.name]?.userPlugin && isPluginEnabled(e.name)).length;

    return (
        <SettingsTab>
            <Heading className={Margins.top16}>User Plugins</Heading>
            <Paragraph className={Margins.bottom16}>
                Manage the plugins you added yourself. They live in your userplugins folder and are loaded when Equicord starts. Changes made on disk are picked up automatically.
            </Paragraph>

            <Notice variant="warning" className={Margins.bottom16}>
                Equicord does not review user plugins. They run with full access to Discord and your account, so only install code from authors you trust.
            </Notice>

            {restartNeeded.length > 0 && (
                <Notice
                    variant="info"
                    className={Margins.bottom16}
                    action={<Button size="small" onClick={relaunch}>Restart</Button>}
                >
                    A restart is needed to apply changes to: {restartNeeded.join(", ")}
                </Notice>
            )}

            <QuickActionCard>
                <QuickAction text="Open Plugins Folder" action={() => VencordNative.userPlugins.openFolder()} Icon={FolderIcon} />
                <QuickAction text="Reload from Disk" action={() => { applyDiskChanges(); refresh(); }} Icon={RestartIcon} />
            </QuickActionCard>

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Install from Git</Heading>
            <Paragraph className={Margins.bottom8}>
                Paste a repository link from GitHub, GitLab or Codeberg. It is cloned into your plugins folder after you confirm. Requires git to be installed.
            </Paragraph>
            <div className={cl("install-row")}>
                <TextInput
                    placeholder="https://github.com/author/plugin"
                    value={gitUrl}
                    onChange={setGitUrl}
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") install(); }}
                />
                <Button onClick={install} disabled={!gitUrl.trim() || busy === "install"}>
                    <PlusIcon width={16} height={16} /> {busy === "install" ? "Installing..." : "Install"}
                </Button>
            </div>

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Installed</Heading>
            <Paragraph color="text-subtle" className={Margins.bottom16}>
                {total} plugin{total !== 1 ? "s" : ""} · {enabled} enabled{problems ? ` · ${problems} with problems` : ""}
            </Paragraph>

            <div className={cl("filter-row")}>
                <TextInput placeholder="Search user plugins..." value={search} onChange={setSearch} />
                <div>
                    <Select
                        options={filterOptions}
                        select={setFilter}
                        isSelected={v => v === filter}
                        serialize={v => v}
                    />
                </div>
            </div>

            {entries === null ? (
                <Paragraph color="text-subtle">Loading...</Paragraph>
            ) : rows.length === 0 ? (
                <Card className={cl("empty")}>
                    <Paragraph>
                        {total === 0
                            ? "No user plugins yet. Drop a plugin folder into the plugins folder, or install one from a git link above."
                            : "No plugins match your search."}
                    </Paragraph>
                </Card>
            ) : (
                <div className={cl("list")}>
                    {rows.map(({ entry, error, plugin }) => (
                        <PluginRow
                            key={entry.dir}
                            entry={entry}
                            error={error}
                            plugin={plugin}
                            busy={busy}
                            restartPending={!!entry.name && restartNeeded.includes(entry.name)}
                            onToggle={() => entry.name && toggle(entry.name)}
                            onUpdate={() => runOp(`update:${entry.dir}`, () => VencordNative.userPlugins.updateFromGit(entry.dir), "Already up to date")}
                            onRemove={() => runOp(`remove:${entry.dir}`, () => VencordNative.userPlugins.remove(entry.dir), "Plugin removed")}
                        />
                    ))}
                </div>
            )}
        </SettingsTab>
    );
}

interface RowProps {
    entry: UserPluginEntry;
    error?: string;
    plugin?: (typeof Plugins)[string];
    busy: string | null;
    restartPending: boolean;
    onToggle(): void;
    onUpdate(): void;
    onRemove(): void;
}

function PluginRow({ entry, error, plugin, busy, restartPending, onToggle, onUpdate, onRemove }: RowProps) {
    const isOn = !!entry.name && isPluginEnabled(entry.name);
    const working = !!busy && busy.endsWith(`:${entry.dir}`);
    const authors = plugin?.authors?.map(a => a.name).join(", ");

    return (
        <Card className={cl("row", { "row-error": !!error || !entry.name })}>
            <div className={cl("row-main")}>
                <div className={cl("row-text")}>
                    <BaseText size="md" weight="bold">{entry.name ?? entry.dir}</BaseText>
                    {authors && <BaseText size="sm" color="text-subtle">by {authors}</BaseText>}
                </div>

                <div className={cl("badges")}>
                    {entry.hasNative && <Badge text="Native" variant="default" />}
                    {entry.gitRemote && <Badge text="Git" variant="default" />}
                    {restartPending && <Badge text="Restart needed" variant="warning" />}
                    {error && <Badge text="Failed to load" variant="danger" />}
                    {!entry.name && <Badge text="Not a plugin" variant="danger" />}
                </div>

                <Switch
                    checked={isOn}
                    onChange={onToggle}
                    disabled={!plugin}
                />
            </div>

            {plugin?.description && <Paragraph color="text-subtle" className={cl("desc")}>{plugin.description}</Paragraph>}

            {error && <pre className={cl("error")}>{error}</pre>}
            {!entry.name && !error && (
                <Paragraph color="text-subtle" className={cl("desc")}>
                    {entry.dir} has no index.ts(x) containing a definePlugin({"{"} name {"}"}) call, so it is ignored.
                </Paragraph>
            )}

            <div className={cl("actions")}>
                <Button size="small" variant="secondary" onClick={() => VencordNative.userPlugins.reveal(entry.dir)}>
                    <FolderIcon width={14} height={14} /> Show in folder
                </Button>
                {entry.gitRemote && (
                    <Button size="small" variant="secondary" disabled={working} onClick={onUpdate}>
                        <RestartIcon width={14} height={14} /> Update
                    </Button>
                )}
                <Button size="small" variant="dangerSecondary" disabled={working} onClick={onRemove}>
                    <DeleteIcon width={14} height={14} /> Remove
                </Button>
            </div>
        </Card>
    );
}

export default wrapTab(UserPluginsTab, "UserPlugins");
