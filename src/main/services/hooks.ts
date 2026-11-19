import fs from "fs";
import os from "os";
import path from "path";
import {shell} from "electron";
import {claudeConfigDir} from "./instructions";
import {findGitRoot, mainWorktreeRoot} from "./skills";

// 확장 창의 훅 탭 — 이 폴더에서 정해진 순간(도구를 쓰기 전, 답을 마칠 때 …) 저절로 도는 훅을 보여 준다. 읽기만 한다.
//
// 목록은 CLI에게 묻는다: control request get_hooks_listing = 터미널 /hooks 메뉴가 그리는 목록(설정 파일·플러그인·세션 훅,
// 이벤트·matcher별, 보여 줄 글까지). SDK의 Query에는 선언되지 않은 getHooksListing()이 sdk.mjs에 있다(SDK 0.3.319 —
// mcp-login.ts의 mcpAuthenticate와 같은 사정) → 좁은 타입 + typeof로 확인한다. 없거나 CLI가 모르면 설정 파일을 직접 읽는다.
//
// 설정 파일 자리 (CLI 코드에서 확인하고 실측함 — CLI 2.1.325):
//   개인    <CLAUDE_CONFIG_DIR 또는 ~/.claude>/settings.json
//   프로젝트 <작업 폴더>/.claude/settings.json — 작업 폴더 그 자체다(레포 루트가 아니다: 하위 폴더에서 열면 루트의 것은 안 읽는다)
//   이 레포에서 나만 <git 루트(작업 트리면 원래 저장소 루트)>/.claude/settings.local.json — 그 루트가 홈이면 작업 폴더
//   관리자  /Library/Application Support/ClaudeCode/managed-settings.json
//   플러그인 설치 기록(installed_plugins.json)의 installPath/hooks/hooks.json (또는 plugin.json의 hooks)

export type HookSourceKind = "user" | "project" | "local" | "managed" | "plugin" | "session" | "flag" | "other";

export interface HookRow {
    event: string;
    matcher: string; // '' = 모든 경우
    source: string; // CLI의 원래 이름 (userSettings, projectSettings, localSettings, policySettings, pluginHook, sessionHook …)
    kind: HookSourceKind;
    sourceLabel: string; // CLI가 붙인 영어 설명
    plugin?: string; // 플러그인 id(이름@마켓플레이스) 또는 이름
    type: string; // command | prompt | agent | http | mcp_tool …
    text: string; // 실제로 도는 명령·프롬프트·URL
    statusMessage?: string;
    condition?: string;
    timeout?: number; // 초
    once?: boolean;
    async?: boolean;
    disabled?: boolean; // 모드·정책 때문에 돌지 않는다
    file?: string; // 이 훅이 적힌 파일 (Finder에서 보기)
}

export interface HookEvent {
    name: string;
    summary: string;
    supportsMatcher: boolean;
    count: number;
}

export type HooksList =
    | {
          ok: true;
          via: "cli" | "files";
          cwd: string;
          events: HookEvent[];
          hooks: HookRow[];
          policy?: {allDisabled: boolean; disabledByPolicy: boolean; managedOnly: boolean; pluginOnly: boolean; policyUnreadable?: boolean};
          safeMode?: string; // 안전 모드 — 나가는 법
          bareMode?: string;
          errors: string[]; // 읽지 못한 설정 파일
          files: {kind: "user" | "project" | "local" | "managed"; path: string; exists: boolean}[];
          note?: string; // CLI에게 못 물은 이유 (파일에서 읽었을 때)
      }
    | {ok: false; error: string};

// get_hooks_listing의 답 (sdk.d.ts의 SDKControlGetHooksListingResponse 중 쓰는 것만)
interface ListingRow {
    event: string;
    matcher: string;
    source: string;
    sourceLabel: string;
    pluginName?: string;
    type: string;
    displayText: string;
    commandText: string;
    contentLabel: string;
    condition?: string;
    timeout?: number;
    statusMessage?: string;
    runsOnce?: boolean;
    runsInBackground?: boolean;
    disabled?: true;
}

interface Listing {
    events: {name: string; summary: string; supportsMatcher: boolean; hookCount: number}[];
    hooks: ListingRow[];
    policy?: {disabledByPolicy: boolean; managedOnly: boolean; pluginOnly: boolean; allDisabled: boolean; policyUnreadable?: true};
    safeMode?: {exitHint: string};
    bareMode?: {exitHint: string};
    errors?: {file?: string; path: string; message: string}[];
}

// getHooksListing이 없는 SDK여도 CLI가 알면 쓰도록, Query 안의 control request 길(request)로도 보낸다 (둘 다 선언에는 없다)
export interface HooksListingMethod {
    getHooksListing?: () => Promise<Listing>;
    request?: (req: {subtype: string}) => Promise<{response?: Listing}>;
}

export interface HooksHost {
    tabId: string;
    cwd: string;
    // 이 폴더에 턴을 시작하지 않는 query를 띄운다 (main.ts의 openIdleQuery)
    query: () => Promise<{q: unknown; close: () => void} | null>;
}

// 이벤트 순서 (CLI /hooks의 순서 — 파일에서 읽을 때 쓴다)
const EVENT_ORDER = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "PermissionDenied",
    "Notification",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "SessionStart",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PreModelSwitch",
    "PostModelSwitch",
    "SessionEnd",
    "PermissionRequest",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "InstructionsLoaded",
    "WorktreeCreate",
    "WorktreeRemove",
    "CwdChanged",
    "FileChanged",
    "DirectoryAdded",
    "MessageDisplay",
];

const NO_MATCHER = new Set(["PostToolBatch", "UserPromptSubmit", "Stop", "TeammateIdle", "TaskCreated", "TaskCompleted", "WorktreeCreate", "WorktreeRemove", "CwdChanged"]);

function realOr(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

function managedSettingsFile(): string {
    if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
    if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    return "/etc/claude-code/managed-settings.json";
}

// 이 레포에서 나만(settings.local.json)의 자리 — git 루트, 작업 트리면 원래 저장소 루트. 루트가 홈이면 작업 폴더.
function localSettingsRoot(cwd: string): string {
    const real = realOr(cwd);
    const root = findGitRoot(real);
    if (!root) return real;
    const canonical = mainWorktreeRoot(root) ?? root;
    return canonical === realOr(os.homedir()) ? real : canonical;
}

export function settingsFiles(cwd: string): {kind: "user" | "project" | "local" | "managed"; path: string; exists: boolean}[] {
    const list: {kind: "user" | "project" | "local" | "managed"; path: string}[] = [
        {kind: "user", path: path.join(claudeConfigDir(), "settings.json")},
        {kind: "project", path: path.join(realOr(cwd), ".claude", "settings.json")},
        {kind: "local", path: path.join(localSettingsRoot(cwd), ".claude", "settings.local.json")},
        {kind: "managed", path: managedSettingsFile()},
    ];
    return list.map((f) => ({...f, exists: fs.existsSync(f.path)}));
}

// 설치된 플러그인 → 설치 폴더 (installed_plugins.json, 이름@마켓플레이스)
function pluginInstallPaths(): Map<string, string> {
    const out = new Map<string, string>();
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), "plugins", "installed_plugins.json"), "utf8")) as {
            plugins?: Record<string, {installPath?: unknown}[]>;
        };
        for (const [id, list] of Object.entries(raw.plugins ?? {})) {
            const p = list?.find((x) => typeof x?.installPath === "string")?.installPath;
            if (typeof p === "string") out.set(id, p);
        }
    } catch {
        // 설치 기록이 없다
    }
    return out;
}

function pluginHooksFile(installPath: string): string | undefined {
    const f = path.join(installPath, "hooks", "hooks.json");
    if (fs.existsSync(f)) return f;
    const manifest = path.join(installPath, ".claude-plugin", "plugin.json");
    return fs.existsSync(manifest) ? manifest : undefined;
}

function pluginIdFor(name: string, installs: Map<string, string>): string | undefined {
    if (installs.has(name)) return name;
    const bare = name.split("@")[0];
    for (const id of installs.keys()) if (id.split("@")[0] === bare) return id;
    return undefined;
}

function kindOf(source: string): HookSourceKind {
    switch (source) {
        case "userSettings":
            return "user";
        case "projectSettings":
            return "project";
        case "localSettings":
            return "local";
        case "policySettings":
            return "managed";
        case "pluginHook":
        case "plugin":
            return "plugin";
        case "sessionHook":
            return "session";
        case "flagSettings":
            return "flag";
        default:
            return "other";
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${ms}ms 시간 초과`)), ms))]);
}

// 탭마다 마지막 목록에 낸 파일 — Finder에서 보기는 이것만
const revealable = new Map<string, Set<string>>();

function fromListing(cwd: string, l: Listing, files: ReturnType<typeof settingsFiles>): HooksList {
    const byKind = new Map(files.map((f) => [f.kind, f.path]));
    const installs = pluginInstallPaths();
    const hooks: HookRow[] = (l.hooks ?? []).map((h) => {
        const kind = kindOf(h.source);
        let file: string | undefined;
        if (kind === "user" || kind === "project" || kind === "local" || kind === "managed") file = byKind.get(kind);
        if (kind === "plugin" && h.pluginName) {
            const id = pluginIdFor(h.pluginName, installs);
            if (id) file = pluginHooksFile(installs.get(id) as string);
        }
        return {
            event: h.event,
            matcher: h.matcher ?? "",
            source: h.source,
            kind,
            sourceLabel: h.sourceLabel ?? h.source,
            plugin: h.pluginName,
            type: h.type,
            text: h.commandText || h.displayText || "",
            statusMessage: h.statusMessage,
            condition: h.condition,
            timeout: typeof h.timeout === "number" ? h.timeout : undefined,
            once: h.runsOnce || undefined,
            async: h.runsInBackground || undefined,
            disabled: h.disabled === true || undefined,
            file: file && fs.existsSync(file) ? file : undefined,
        };
    });
    const events: HookEvent[] = (l.events ?? []).map((e) => ({name: e.name, summary: e.summary, supportsMatcher: e.supportsMatcher, count: e.hookCount}));
    return {
        ok: true,
        via: "cli",
        cwd,
        events,
        hooks,
        policy: l.policy && {
            allDisabled: l.policy.allDisabled,
            disabledByPolicy: l.policy.disabledByPolicy,
            managedOnly: l.policy.managedOnly,
            pluginOnly: l.policy.pluginOnly,
            policyUnreadable: l.policy.policyUnreadable === true || undefined,
        },
        safeMode: l.safeMode?.exitHint,
        bareMode: l.bareMode?.exitHint,
        errors: (l.errors ?? []).map((e) => `${e.file ? `${e.file}: ` : ""}${e.path ? `${e.path} — ` : ""}${e.message}`),
        files,
    };
}

// ── CLI에게 못 물었을 때: 설정 파일을 직접 읽는다 ──
interface RawHook {
    type?: unknown;
    command?: unknown;
    prompt?: unknown;
    url?: unknown;
    timeout?: unknown;
    statusMessage?: unknown;
    async?: unknown;
    once?: unknown;
    if?: unknown;
}

function rowsFromConfig(hooks: unknown, base: Omit<HookRow, "event" | "matcher" | "type" | "text">): HookRow[] {
    const out: HookRow[] = [];
    if (!hooks || typeof hooks !== "object") return out;
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups as {matcher?: unknown; hooks?: unknown}[]) {
            const matcher = typeof g?.matcher === "string" ? g.matcher : "";
            if (!Array.isArray(g?.hooks)) continue;
            for (const h of g.hooks as RawHook[]) {
                const type = typeof h?.type === "string" ? h.type : "command";
                const text = [h?.command, h?.prompt, h?.url].find((v): v is string => typeof v === "string") ?? JSON.stringify(h);
                out.push({
                    ...base,
                    event,
                    matcher,
                    type,
                    text,
                    statusMessage: typeof h?.statusMessage === "string" ? h.statusMessage : undefined,
                    condition: typeof h?.if === "string" ? h.if : undefined,
                    timeout: typeof h?.timeout === "number" ? h.timeout : undefined,
                    async: h?.async === true || undefined,
                    once: h?.once === true || undefined,
                });
            }
        }
    }
    return out;
}

function readJson(p: string): {value?: Record<string, unknown>; error?: string} {
    try {
        return {value: JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>};
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
        return {error: `${p}: ${(e as Error).message}`};
    }
}

const SOURCE_OF: Record<"user" | "project" | "local" | "managed", string> = {
    user: "userSettings",
    project: "projectSettings",
    local: "localSettings",
    managed: "policySettings",
};

function fromFiles(cwd: string, files: ReturnType<typeof settingsFiles>, note: string): HooksList {
    const hooks: HookRow[] = [];
    const errors: string[] = [];
    const enabled = new Map<string, boolean>();
    let allDisabled = false;
    for (const f of files) {
        if (!f.exists) continue;
        const r = readJson(f.path);
        if (r.error) {
            errors.push(r.error);
            continue;
        }
        const v = r.value ?? {};
        if (v.disableAllHooks === true) allDisabled = true;
        const ep = v.enabledPlugins;
        if (ep && typeof ep === "object") for (const [id, on] of Object.entries(ep as Record<string, unknown>)) enabled.set(id, on === true);
        hooks.push(...rowsFromConfig(v.hooks, {source: SOURCE_OF[f.kind], kind: f.kind, sourceLabel: f.path, file: f.path}));
    }
    const installs = pluginInstallPaths();
    for (const [id, on] of enabled) {
        if (!on || !installs.has(id)) continue;
        const file = pluginHooksFile(installs.get(id) as string);
        if (!file) continue;
        const r = readJson(file);
        if (r.error) {
            errors.push(r.error);
            continue;
        }
        // hooks.json = {hooks: {...}} · plugin.json의 hooks = 객체(또는 파일 경로 — 그건 따라가지 않는다)
        const cfg = r.value?.hooks;
        if (cfg && typeof cfg === "object") hooks.push(...rowsFromConfig(cfg, {source: "pluginHook", kind: "plugin", sourceLabel: id, plugin: id, file}));
    }
    const order = (e: string) => (EVENT_ORDER.indexOf(e) < 0 ? 999 : EVENT_ORDER.indexOf(e));
    hooks.sort((a, b) => order(a.event) - order(b.event));
    const events: HookEvent[] = [];
    for (const h of hooks) {
        const e = events.find((x) => x.name === h.event);
        if (e) e.count += 1;
        else events.push({name: h.event, summary: "", supportsMatcher: !NO_MATCHER.has(h.event), count: 1});
    }
    return {
        ok: true,
        via: "files",
        cwd,
        events,
        hooks,
        policy: {allDisabled, disabledByPolicy: false, managedOnly: false, pluginOnly: false},
        errors,
        files,
        note,
    };
}

export async function listHooks(host: HooksHost): Promise<HooksList> {
    const cwd = host.cwd;
    const files = settingsFiles(cwd);
    let listing: Listing | null = null;
    let note = "";
    const opened = await host.query().catch((e: unknown) => {
        note = String(e);
        return null;
    });
    if (opened) {
        try {
            const q = opened.q as HooksListingMethod;
            const fn = q.getHooksListing;
            if (typeof fn === "function") {
                listing = await withTimeout(fn.call(q) as Promise<Listing>, 15_000);
            } else if (typeof q.request === "function") {
                const sent = q.request.call(q, {subtype: "get_hooks_listing"}) as Promise<{response?: Listing}>;
                listing = (await withTimeout(sent, 15_000))?.response ?? null;
                if (!listing) note = "CLI가 훅 목록을 비워 보냈습니다";
            } else {
                note = "이 SDK는 훅 목록 요청(get_hooks_listing)을 모릅니다";
            }
        } catch (e) {
            const msg = (e as Error).message ?? String(e);
            note = /Unsupported control request/i.test(msg) ? "이 CLI는 훅 목록 요청(get_hooks_listing)을 모릅니다" : msg;
        } finally {
            opened.close();
        }
    } else if (!note) {
        note = "Claude CLI를 실행하지 못했습니다";
    }
    const result = listing ? fromListing(cwd, listing, files) : fromFiles(cwd, files, note);
    if (result.ok === true) {
        revealable.set(host.tabId, new Set([...result.files.filter((f) => f.exists).map((f) => f.path), ...result.hooks.map((h) => h.file).filter((f): f is string => !!f)]));
    }
    return result;
}

// Finder에서 보기 — 마지막 목록에 낸 설정·플러그인 훅 파일만
export function revealHookFile(tabId: string, p: unknown): boolean {
    if (typeof p !== "string" || !revealable.get(tabId)?.has(p) || !fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
}
