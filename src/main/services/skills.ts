import fs from "fs";
import os from "os";
import path from "path";
import {randomUUID} from "crypto";
import {shell} from "electron";
import {claudeConfigDir, writeFileAtomic} from "./instructions";

// 확장 창의 스킬 탭 — 이 폴더에서 Claude가 쓸 수 있는 스킬(과 옛 명령)을 모으고, 내 스킬·프로젝트 스킬을 읽고 고치고 만든다.
// 스킬 = 서랍 속 매뉴얼: 이름과 설명만 늘 컨텍스트에 있고(그 토큰), 본문은 쓸 때 읽는다. /이름으로 직접 부를 수도 있다.
//
// 어디서 오는지 세 군데를 합친다 (CLI 2.1.325 실측):
//   1) CLI의 getContextUsage({detail: "full"}).skills.skillFrontmatter — {name, source, pluginName, pluginId, path, tokens}.
//      늘 들어가는 토큰과 파일 경로. disable-model-invocation 스킬은 컨텍스트에 없어 여기 없다.
//   2) CLI의 명령 목록(supportedCommands) — 직접만 부르는 스킬, 플러그인 스킬 이름("플러그인:스킬")까지 다 있다.
//      설명 앞뒤에 출처 표시가 붙어 온다: "… (user)", "… (project)", "(figma) …".
//   3) 디스크 — CLI가 읽는 폴더를 그대로 따라 읽는다(CLI 코드에서 확인하고 실측함):
//      개인: <CLAUDE_CONFIG_DIR 또는 ~/.claude>/skills/<이름>/SKILL.md, 옛 명령 <설정>/commands/**/*.md
//      프로젝트: 작업 폴더부터 위로 git 루트까지(루트 포함, 홈 폴더는 빼고 — 홈의 .claude는 개인 것) 각 폴더의
//        .claude/skills/<이름>/SKILL.md 와 .claude/commands/**/*.md. 작업 폴더 아래는 시작 때 읽지 않는다(그 폴더 파일을 다룰
//        때 불려 온다). git 밖이면 홈 바로 아래(또는 /)까지.
//        연결된 작업 트리(git worktree)인데 그 루트에 .claude/skills가 없으면 원래 저장소 루트의 것을 대신 읽는다.
//      관리자: /Library/Application Support/ClaudeCode/.claude/skills (읽기 전용)
//      폴더 안에 .claude-plugin이 있으면 스킬이 아니라 플러그인이라 건너뛴다. 옛 명령의 하위 폴더는 이름에 ":"로 붙는다
//      (commands/grp/inner.md → grp:inner).
//
// 고치기는 지침 패널과 같은 규칙: main이 마지막 목록에 낸 경로만 읽고 쓰고, 연 뒤에 바뀌었으면(수정 시각) 덮어쓰지 않고 알리며,
// 임시 파일 + rename으로 실제 파일(심볼릭 링크면 그 대상)에 쓴다. 새 스킬은 있는 폴더를 덮어쓰지 않는다.

export type SkillScope = "personal" | "project" | "plugin" | "managed" | "builtin" | "synced" | "other";

// CLI가 컨텍스트 계산에서 알려 주는 스킬 한 줄 (getContextUsage full의 skills.skillFrontmatter)
export interface ContextSkill {
    name: string;
    source: string;
    pluginName?: string;
    pluginId?: string;
    path?: string;
    tokens: number;
}

export interface CommandInfo {
    name: string; // "/이름"
    description: string;
    argumentHint?: string;
    source: "builtin" | "custom";
    aliases?: string[];
}

export interface SkillEntry {
    id: string; // 목록에서 고르는 열쇠 — 파일이 있으면 그 경로
    name: string; // Claude가 부르는 이름 = 입력창의 /이름 (플러그인 스킬은 "플러그인:스킬")
    scope: SkillScope;
    legacy: boolean; // 옛 방식 .claude/commands/*.md
    plugin?: string; // 플러그인 이름
    pluginId?: string; // 이름@마켓플레이스
    description: string;
    whenToUse?: string;
    argumentHint?: string;
    tokens: number | null; // 늘 컨텍스트에 들어가는 토큰 (null = 모름)
    manualOnly: boolean; // disable-model-invocation: true — 직접 부를 때만
    userInvocable: boolean; // user-invocable: false면 /이름으로 부를 수 없다 (Claude만 쓴다)
    paths?: string[]; // paths: — 맞는 파일을 다룰 때만 불려 오는 스킬
    path?: string; // SKILL.md 또는 옛 명령 .md
    dir?: string; // 스킬 폴더 (SKILL.md일 때)
    base?: string; // 프로젝트 스킬: .claude가 있는 폴더 / 개인: 설정 폴더
    editable: boolean;
    loaded: boolean; // CLI가 이 스킬을 안다 (명령 목록이나 컨텍스트에 있다)
}

export type ProjectTarget =
    | {ok: true; dir: string; base: string; kind: "git" | "folder" | "worktree-main"}
    | {ok: false; reason: string};

export type SkillsList =
    | {
          ok: true;
          cwd: string;
          skills: SkillEntry[];
          measured: boolean; // 토큰을 CLI에게서 받았다
          measuredAt?: number;
          totalSkills?: number; // CLI가 센 스킬 수와 그중 설명이 컨텍스트에 든 수 (많으면 일부가 빠진다)
          includedSkills?: number;
          personalDir: string;
          project: ProjectTarget;
          takenNames: string[]; // 새 스킬 이름으로 쓸 수 없는 이름 (이미 있는 명령·스킬)
      }
    | {ok: false; error: string};

export interface SkillsHost {
    tabId: string;
    cwd: string;
    // 지침 패널과 같은 측정(getContextUsage full, main의 instructionCache) — 스킬별 토큰
    measure: (refresh: boolean) => Promise<{skills: ContextSkill[] | null; totalSkills?: number; includedSkills?: number; at: number} | null>;
    // 입력창 "/" 메뉴와 같은 명령 목록 (살아 있는 세션, 없으면 폴더 정보)
    commands: (refresh: boolean) => Promise<CommandInfo[]>;
    // 앱에서 스킬 파일을 쓰고 난 뒤 — 다시 세기, 살아 있는 세션의 reloadSkills, "/" 메뉴 새로
    changed: () => void;
}

const MAX_SKILL_BYTES = 1024 * 1024;
const FRONTMATTER_READ = 32 * 1024;
const MAX_FOLDER_FILES = 200;

// ── 경로 ──

function exists(p: string): boolean {
    try {
        fs.accessSync(p);
        return true;
    } catch {
        return false;
    }
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function realOr(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

function within(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

// 관리자(회사 정책) 폴더 — CLI의 managed 경로와 같다
function managedBase(): string {
    if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
    if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
    return "/etc/claude-code";
}

// 위로 올라가며 .git(폴더 또는 작업 트리의 파일)이 있는 곳
export function findGitRoot(dir: string): string | null {
    let d = dir;
    for (;;) {
        if (exists(path.join(d, ".git"))) return d;
        const parent = path.dirname(d);
        if (parent === d) return null;
        d = parent;
    }
}

// 연결된 작업 트리(git worktree add)면 원래 저장소의 루트 — .git 파일의 gitdir → commondir
export function mainWorktreeRoot(root: string): string | null {
    const dotGit = path.join(root, ".git");
    try {
        if (!fs.statSync(dotGit).isFile()) return null;
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (!m) return null;
        const gitdir = path.resolve(root, m[1].trim());
        let common = gitdir;
        try {
            common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
        } catch {
            return null;
        }
        return path.basename(common) === ".git" ? path.dirname(common) : null;
    } catch {
        return null;
    }
}

// CLI가 대화를 시작할 때 읽는 프로젝트 폴더들의 .claude/<sub> (있는 것만, 작업 폴더에 가까운 것부터)
export function projectClaudeDirs(cwd: string, sub: "skills" | "commands"): string[] {
    const home = realOr(os.homedir());
    const start = realOr(cwd);
    const root = findGitRoot(start);
    const out: string[] = [];
    let d = start;
    for (;;) {
        if (d === home) break;
        out.push(path.join(d, ".claude", sub));
        if (root && d === root) break;
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
    }
    const found = out.filter(isDir);
    if (root) {
        const main = mainWorktreeRoot(root);
        const own = path.join(root, ".claude", sub);
        if (main && main !== root && !found.includes(own)) {
            const fallback = path.join(main, ".claude", sub);
            if (isDir(fallback)) found.push(fallback);
        }
    }
    return found;
}

// 새 프로젝트 스킬을 둘 곳 — 저장소 루트의 .claude/skills (git으로 함께 쓴다). git 밖이면 작업 폴더.
// 작업 트리인데 원래 저장소에만 .claude/skills가 있으면 거기 (작업 트리에 새로 만들면 CLI가 원래 것을 더는 읽지 않는다).
export function projectTarget(cwd: string): ProjectTarget {
    if (!cwd || !isDir(cwd)) return {ok: false, reason: "작업 폴더가 없습니다"};
    const home = realOr(os.homedir());
    const real = realOr(cwd);
    if (real === home) return {ok: false, reason: "홈 폴더에서는 프로젝트 스킬을 만들 수 없습니다 — 프로젝트 폴더를 연 탭에서 만드세요"};
    const root = findGitRoot(real);
    if (root && !within(root, home)) {
        const own = path.join(root, ".claude", "skills");
        const main = mainWorktreeRoot(root);
        if (main && main !== root && !isDir(own) && isDir(path.join(main, ".claude", "skills"))) {
            return {ok: true, dir: path.join(main, ".claude", "skills"), base: main, kind: "worktree-main"};
        }
        return {ok: true, dir: own, base: root, kind: "git"};
    }
    return {ok: true, dir: path.join(real, ".claude", "skills"), base: real, kind: "folder"};
}

export function personalSkillsDir(): string {
    return path.join(claudeConfigDir(), "skills");
}

// ── frontmatter ──
// 스킬에 필요한 키만 읽는다. 값이 여러 줄(> 또는 |)이면 들여쓴 줄을 이어 붙이고, 목록(- a)도 읽는다.
interface SkillMeta {
    name?: string;
    description?: string;
    whenToUse?: string;
    argumentHint?: string;
    manualOnly: boolean;
    userInvocable: boolean;
    paths?: string[];
}

function unquote(v: string): string {
    const t = v.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
        try {
            return JSON.parse(t) as string;
        } catch {
            return t.slice(1, -1);
        }
    }
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    return t;
}

export function frontmatterOf(text: string): {fields: Record<string, string | string[]>; body: string} {
    const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return {fields: {}, body: text};
    const fields: Record<string, string | string[]> = {};
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        let value = kv[2].trim();
        if (/^[|>][+-]?$/.test(value)) {
            const parts: string[] = [];
            while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) parts.push(lines[++i].trim());
            value = value.startsWith("|") ? parts.join("\n").trim() : parts.join(" ").replace(/\s+/g, " ").trim();
            fields[key] = value;
        } else if (value === "" && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
            const items: string[] = [];
            while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
            fields[key] = items;
        } else if (value.startsWith("[") && value.endsWith("]")) {
            fields[key] = value
                .slice(1, -1)
                .split(",")
                .map(unquote)
                .filter(Boolean);
        } else {
            fields[key] = unquote(value);
        }
    }
    return {fields, body: text.slice(m[0].length)};
}

function str(v: string | string[] | undefined): string | undefined {
    if (v === undefined) return undefined;
    const s = Array.isArray(v) ? v.join(", ") : v;
    return s.trim() || undefined;
}

function metaOf(text: string): SkillMeta {
    const {fields} = frontmatterOf(text);
    const flag = (v: string | string[] | undefined) => typeof v === "string" && /^(true|yes|on)$/i.test(v.trim());
    const off = (v: string | string[] | undefined) => typeof v === "string" && /^(false|no|off)$/i.test(v.trim());
    const paths = fields.paths;
    return {
        name: str(fields.name),
        description: str(fields.description),
        whenToUse: str(fields.when_to_use) ?? str(fields["when-to-use"]),
        argumentHint: str(fields["argument-hint"]),
        manualOnly: flag(fields["disable-model-invocation"]),
        userInvocable: !off(fields["user-invocable"]),
        paths: Array.isArray(paths) ? paths : typeof paths === "string" && paths.trim() ? paths.split(",").map((s) => s.trim()) : undefined,
    };
}

function readHead(p: string): string {
    let fd: number | null = null;
    try {
        fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(FRONTMATTER_READ);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n).toString("utf8");
    } catch {
        return "";
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
}

// 명령 목록의 설명에 CLI가 붙인 출처 표시를 뗀다 — "설명 (project)", "(figma) 설명"
export function cleanDescription(d: string, plugin?: string): string {
    let t = d.trim();
    if (plugin && t.startsWith(`(${plugin}) `)) t = t.slice(plugin.length + 3);
    return t.replace(/\s+\((?:user|project|managed|policy|local|plugin)\)$/i, "").trim();
}

// ── 디스크에서 찾기 ──

interface DiskSkill {
    name: string;
    scope: SkillScope;
    legacy: boolean;
    path: string;
    real: string;
    dir?: string;
    base: string;
    meta: SkillMeta;
    mtimeMs: number;
}

function scanSkillsDir(dir: string, scope: SkillScope, base: string, skipNames: Set<string> = new Set()): DiskSkill[] {
    let names: fs.Dirent[];
    try {
        names = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
        return [];
    }
    const out: DiskSkill[] = [];
    for (const d of names) {
        if (d.name.startsWith(".") || skipNames.has(d.name)) continue;
        if (!d.isDirectory() && !d.isSymbolicLink()) continue;
        const folder = path.join(dir, d.name);
        if (!isDir(folder) || exists(path.join(folder, ".claude-plugin"))) continue;
        const file = path.join(folder, "SKILL.md");
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            continue;
        }
        if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
        out.push({
            name: d.name,
            scope,
            legacy: false,
            path: file,
            real: realOr(file),
            dir: folder,
            base,
            meta: metaOf(readHead(file)),
            mtimeMs: Math.max(st.mtimeMs, safeMtime(folder)),
        });
    }
    return out;
}

function safeMtime(p: string): number {
    try {
        return fs.statSync(p).mtimeMs;
    } catch {
        return 0;
    }
}

// 옛 명령: .claude/commands 아래 .md 전부 — 하위 폴더는 이름에 ":"로 (grp/inner.md → grp:inner)
function scanCommandsDir(dir: string, scope: SkillScope, base: string): DiskSkill[] {
    const out: DiskSkill[] = [];
    const seen = new Set<string>();
    const walk = (d: string, prefix: string[], depth: number) => {
        if (depth > 6 || out.length > 500) return;
        const real = realOr(d);
        if (seen.has(real)) return;
        seen.add(real);
        let list: fs.Dirent[];
        try {
            list = fs.readdirSync(d, {withFileTypes: true});
        } catch {
            return;
        }
        for (const e of list) {
            if (e.name.startsWith(".")) continue;
            const p = path.join(d, e.name);
            if (isDir(p)) {
                walk(p, [...prefix, e.name], depth + 1);
            } else if (e.name.endsWith(".md")) {
                let st: fs.Stats;
                try {
                    st = fs.statSync(p);
                } catch {
                    continue;
                }
                if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
                out.push({
                    name: [...prefix, e.name.slice(0, -3)].join(":"),
                    scope,
                    legacy: true,
                    path: p,
                    real: realOr(p),
                    base,
                    meta: metaOf(readHead(p)),
                    mtimeMs: st.mtimeMs,
                });
            }
        }
    };
    walk(dir, [], 0);
    return out;
}

function scanDisk(cwd: string): {items: DiskSkill[]; dirs: string[]} {
    const config = claudeConfigDir();
    const personal = personalSkillsDir();
    const items: DiskSkill[] = [
        // synced = claude.ai에서 받은 스킬(CLI가 따로 읽는다 — 목록은 CLI가 알려 준 것만 쓴다)
        ...scanSkillsDir(personal, "personal", config, new Set(["synced"])),
        ...scanCommandsDir(path.join(config, "commands"), "personal", config),
    ];
    const dirs = [personal, path.join(config, "commands")];
    for (const d of projectClaudeDirs(cwd, "skills")) {
        items.push(...scanSkillsDir(d, "project", path.dirname(path.dirname(d))));
        dirs.push(d);
    }
    for (const d of projectClaudeDirs(cwd, "commands")) {
        items.push(...scanCommandsDir(d, "project", path.dirname(path.dirname(d))));
        dirs.push(d);
    }
    const managed = path.join(managedBase(), ".claude");
    items.push(...scanSkillsDir(path.join(managed, "skills"), "managed", managedBase()));
    items.push(...scanCommandsDir(path.join(managed, "commands"), "managed", managedBase()));
    return {items, dirs};
}

// ── 탭마다: main이 목록에 낸 경로 ──
// 렌더러가 넘긴 아무 경로나 읽고 쓰지 않으려고, 마지막 skills:list가 낸 파일·폴더만 받는다.
interface Access {
    editable: Set<string>; // 고칠 수 있는 파일 (개인·프로젝트 스킬의 SKILL.md, 옛 명령 .md)
    readable: Set<string>; // 읽을 수 있는 파일 (플러그인·관리자 스킬 포함)
    folders: Set<string>; // 스킬 폴더 — 안의 다른 파일도 읽기 전용으로 보여 준다
}

const access = new Map<string, Access>();

function accessFor(tabId: string): Access {
    let a = access.get(tabId);
    if (!a) {
        a = {editable: new Set(), readable: new Set(), folders: new Set()};
        access.set(tabId, a);
    }
    return a;
}

function scopeOfSource(source: string): SkillScope {
    switch (source) {
        case "userSettings":
            return "personal";
        case "projectSettings":
        case "localSettings":
            return "project";
        case "plugin":
            return "plugin";
        case "policySettings":
            return "managed";
        case "built-in":
        case "builtin":
        case "bundled":
            return "builtin";
        case "syncedSkills":
            return "synced";
        default:
            return "other";
    }
}

// 플러그인 스킬 파일 — CLI가 경로를 알려 주지 않은 것(직접만 부르는 스킬)은 같은 플러그인의 다른 스킬 옆이나
// 설치 기록(installed_plugins.json의 installPath)에서 찾는다
function pluginRoots(): Map<string, string> {
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

export async function listSkills(host: SkillsHost, refresh = false): Promise<SkillsList> {
    const cwd = host.cwd;
    const disk = scanDisk(cwd);
    let [measure, commands] = await Promise.all([host.measure(refresh), host.commands(refresh).catch(() => [] as CommandInfo[])]);
    if (!refresh) {
        // 잰 뒤에 스킬 파일이 바뀌었거나(터미널·편집기·Claude가 고침), CLI가 모르는 내 스킬·프로젝트 스킬이 있으면 다시 묻는다
        // (폴더 정보는 폴더마다 한 번 받아 둔 것이라, 그 뒤에 만든 스킬은 모른다)
        // 플러그인을 설치·켜고 끄면(터미널의 claude plugin …) 설치 기록이나 설정 파일이 바뀐다 — 그것도 본다
        const known = new Set(commands.map((c) => c.name.slice(1)));
        const now = Date.now() + 1000;
        const at = measure?.at ?? 0;
        const newer = (m: number) => m > at && m < now;
        const config = claudeConfigDir();
        const stale =
            !!measure &&
            (disk.items.some((d) => newer(d.mtimeMs)) ||
                newer(safeMtime(path.join(config, "plugins", "installed_plugins.json"))) ||
                newer(safeMtime(path.join(config, "settings.json"))) ||
                disk.items.some((d) => (d.scope === "personal" || d.scope === "project") && !known.has(d.name)));
        if (stale) [measure, commands] = await Promise.all([host.measure(true), host.commands(true).catch(() => commands)]);
    }

    const ctx = measure?.skills ?? [];
    const commandByName = new Map(commands.map((c) => [c.name.slice(1), c]));
    const entries: SkillEntry[] = [];
    const byReal = new Map<string, SkillEntry>();

    const fromDisk = (d: DiskSkill): SkillEntry => {
        const cmd = commandByName.get(d.name);
        const e: SkillEntry = {
            id: d.path,
            name: d.name,
            scope: d.scope,
            legacy: d.legacy,
            description: d.meta.description ?? (cmd ? cleanDescription(cmd.description) : ""),
            whenToUse: d.meta.whenToUse,
            argumentHint: d.meta.argumentHint ?? cmd?.argumentHint,
            tokens: measure ? 0 : null,
            manualOnly: d.meta.manualOnly,
            userInvocable: d.meta.userInvocable,
            paths: d.meta.paths,
            path: d.path,
            dir: d.dir,
            base: d.base,
            editable: d.scope === "personal" || d.scope === "project",
            loaded: !!cmd && cmd.source === "custom",
        };
        return e;
    };

    for (const d of disk.items) {
        // 같은 파일(심볼릭 링크로 두 번 보임)은 한 번만
        if (byReal.has(d.real)) continue;
        const e = fromDisk(d);
        entries.push(e);
        byReal.set(d.real, e);
    }

    // CLI가 컨텍스트에 넣은 스킬 — 토큰과, 디스크에서 못 찾은 것(플러그인·기본 제공·claude.ai 동기화)
    const roots = pluginRoots();
    const pluginSkillDirs = new Map<string, string>(); // 플러그인 id → skills 폴더 (아는 스킬 경로에서)
    for (const s of ctx) {
        const known = s.path ? byReal.get(realOr(s.path)) : undefined;
        if (known) {
            known.tokens = s.tokens;
            known.loaded = true;
            continue;
        }
        const scope = scopeOfSource(s.source);
        const cmd = commandByName.get(s.name);
        const plugin = s.pluginName ?? (scope === "plugin" && s.name.includes(":") ? s.name.split(":")[0] : undefined);
        let text = "";
        if (s.path) {
            const head = readHead(s.path);
            const meta = metaOf(head);
            text = meta.description ?? "";
            const e: SkillEntry = {
                id: s.path,
                name: s.name,
                scope,
                legacy: s.path.includes(`${path.sep}commands${path.sep}`) && path.basename(s.path) !== "SKILL.md",
                plugin,
                pluginId: s.pluginId,
                description: text || (cmd ? cleanDescription(cmd.description, plugin) : ""),
                whenToUse: meta.whenToUse,
                argumentHint: meta.argumentHint ?? cmd?.argumentHint,
                tokens: s.tokens,
                manualOnly: meta.manualOnly,
                userInvocable: meta.userInvocable,
                paths: meta.paths,
                path: s.path,
                dir: path.basename(s.path) === "SKILL.md" ? path.dirname(s.path) : undefined,
                // 시작 폴더 목록 밖에서 CLI가 찾은 개인·프로젝트 스킬(추가한 폴더 등)도 그 파일이라 고칠 수 있다
                editable: scope === "personal" || scope === "project",
                loaded: true,
            };
            entries.push(e);
            byReal.set(realOr(s.path), e);
            if (scope === "plugin" && s.pluginId && e.dir) pluginSkillDirs.set(s.pluginId, path.dirname(e.dir));
        } else {
            entries.push({
                id: `${scope}:${s.name}`,
                name: s.name,
                scope,
                legacy: false,
                plugin,
                pluginId: s.pluginId,
                description: cmd ? cleanDescription(cmd.description, plugin) : "",
                argumentHint: cmd?.argumentHint,
                tokens: s.tokens,
                manualOnly: false,
                userInvocable: true,
                editable: false,
                loaded: true,
            });
        }
    }

    // 명령 목록에만 있는 것 — 직접만 부르는 플러그인 스킬 등. MCP 프롬프트(mcp__…)는 스킬이 아니라 뺀다.
    const named = new Set(entries.map((e) => e.name));
    for (const c of commands) {
        const name = c.name.slice(1);
        if (c.source !== "custom" || named.has(name) || name.startsWith("mcp__")) continue;
        const colon = name.indexOf(":");
        const plugin = colon > 0 ? name.slice(0, colon) : undefined;
        let file: string | undefined;
        let pluginId: string | undefined;
        if (plugin) {
            const skill = name.slice(colon + 1);
            const candidates: [string, string][] = [];
            for (const [id, dir] of pluginSkillDirs) if (id.split("@")[0] === plugin) candidates.push([id, dir]);
            for (const [id, root] of roots) if (id.split("@")[0] === plugin) candidates.push([id, path.join(root, "skills")]);
            for (const [id, dir] of candidates) {
                const p = path.join(dir, skill, "SKILL.md");
                if (exists(p)) {
                    file = p;
                    pluginId = id;
                    break;
                }
            }
        }
        const meta = file ? metaOf(readHead(file)) : null;
        entries.push({
            id: file ?? `cmd:${name}`,
            name,
            scope: plugin ? "plugin" : "other",
            legacy: false,
            plugin,
            pluginId,
            description: meta?.description ?? cleanDescription(c.description, plugin),
            whenToUse: meta?.whenToUse,
            argumentHint: meta?.argumentHint ?? c.argumentHint,
            tokens: measure ? 0 : null,
            manualOnly: meta?.manualOnly ?? !!measure,
            userInvocable: meta?.userInvocable ?? true,
            paths: meta?.paths,
            path: file,
            dir: file ? path.dirname(file) : undefined,
            editable: false,
            loaded: true,
        });
        named.add(name);
    }

    // 이 탭이 읽고 고칠 수 있는 경로
    const a = accessFor(host.tabId);
    a.editable = new Set(entries.filter((e) => e.editable && e.path).map((e) => e.path as string));
    a.readable = new Set(entries.filter((e) => e.path).map((e) => e.path as string));
    a.folders = new Set(entries.filter((e) => e.dir).map((e) => e.dir as string));

    const taken = new Set<string>();
    for (const c of commands) {
        taken.add(c.name.slice(1));
        for (const al of c.aliases ?? []) taken.add(al.replace(/^\//, ""));
    }
    for (const e of entries) taken.add(e.name);

    return {
        ok: true,
        cwd,
        skills: entries,
        measured: !!measure,
        measuredAt: measure?.at,
        totalSkills: measure?.totalSkills,
        includedSkills: measure?.includedSkills,
        personalDir: personalSkillsDir(),
        project: projectTarget(cwd),
        takenNames: [...taken].sort(),
    };
}

// ── 읽기 ──

export type SkillFileRead =
    | {
          ok: true;
          content: string;
          mtimeMs: number;
          readOnly: boolean;
          files?: {rel: string; size: number}[]; // 스킬 폴더의 다른 파일 (SKILL.md를 읽을 때)
          filesTruncated?: boolean;
      }
    | {ok: false; error: string};

function folderOf(a: Access, p: string): string | null {
    for (const f of a.folders) if (within(f, p) && p !== f) return f;
    return null;
}

function cleanPath(p: unknown): string | null {
    if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0") || path.resolve(p) !== p) return null;
    return p;
}

function listFolder(dir: string): {files: {rel: string; size: number}[]; truncated: boolean} {
    const files: {rel: string; size: number}[] = [];
    let truncated = false;
    const rootReal = realOr(dir);
    const walk = (d: string, depth: number) => {
        if (depth > 5) return;
        let list: fs.Dirent[];
        try {
            list = fs.readdirSync(d, {withFileTypes: true});
        } catch {
            return;
        }
        list.sort((x, y) => x.name.localeCompare(y.name));
        for (const e of list) {
            if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                walk(p, depth + 1);
            } else if (e.isFile() || e.isSymbolicLink()) {
                if (p === path.join(dir, "SKILL.md")) continue;
                // 폴더 밖을 가리키는 링크는 보이지 않는다
                if (!within(rootReal, realOr(p))) continue;
                if (files.length >= MAX_FOLDER_FILES) {
                    truncated = true;
                    return;
                }
                let size = 0;
                try {
                    size = fs.statSync(p).size;
                } catch {
                    continue;
                }
                files.push({rel: path.relative(dir, p), size});
            }
        }
    };
    walk(dir, 0);
    return {files, truncated};
}

export async function readSkillFile(tabId: string, raw: unknown): Promise<SkillFileRead> {
    const p = cleanPath(raw);
    const a = access.get(tabId);
    if (!p || !a) return {ok: false, error: "스킬 목록에서 열 수 있는 파일이 아닙니다"};
    const listed = a.readable.has(p);
    const folder = listed ? null : folderOf(a, p);
    if (!listed && !folder) return {ok: false, error: "스킬 목록에서 열 수 있는 파일이 아닙니다"};
    // 스킬 폴더 안의 다른 파일: 실제 경로도 폴더 안이어야 한다 (밖을 가리키는 링크는 거절)
    if (folder && !within(realOr(folder), realOr(p))) return {ok: false, error: "스킬 폴더 밖을 가리키는 파일입니다"};
    try {
        const st = await fs.promises.stat(p);
        if (!st.isFile()) return {ok: false, error: "파일이 아닙니다"};
        if (st.size > MAX_SKILL_BYTES) return {ok: false, error: "파일이 너무 큽니다 (1MB 넘음)"};
        const buf = await fs.promises.readFile(p);
        if (buf.subarray(0, 8192).includes(0)) return {ok: false, error: "글이 아닌 파일이라 보여 줄 수 없습니다"};
        const extra = listed && path.basename(p) === "SKILL.md" ? listFolder(path.dirname(p)) : null;
        return {
            ok: true,
            content: buf.toString("utf8"),
            mtimeMs: st.mtimeMs,
            readOnly: !a.editable.has(p),
            files: extra?.files,
            filesTruncated: extra?.truncated || undefined,
        };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {ok: false, error: "파일이 없습니다 — 지워졌거나 옮겨졌습니다"};
        return {ok: false, error: (e as Error).message};
    }
}

// ── 고치기 ──

export type SkillFileWrite = {ok: true; mtimeMs: number} | {ok: false; conflict?: boolean; exists?: boolean; error?: string};

export async function writeSkillFile(host: SkillsHost, raw: unknown, content: unknown, baseMtime: unknown, force: boolean): Promise<SkillFileWrite> {
    const p = cleanPath(raw);
    const a = access.get(host.tabId);
    if (!p || !a || !a.editable.has(p)) return {ok: false, error: "고칠 수 없는 스킬입니다"};
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_SKILL_BYTES) return {ok: false, error: "내용이 너무 큽니다 (1MB 넘음)"};
    let current: number | null = null;
    try {
        current = (await fs.promises.stat(p)).mtimeMs;
    } catch {
        current = null;
    }
    if (!force && current !== (typeof baseMtime === "number" ? baseMtime : null)) return {ok: false, conflict: true, exists: current !== null};
    // 지워진 스킬 폴더는 되살리지 않는다 (그래도 덮어쓰기 = 파일만 다시 만든다)
    if (!isDir(path.dirname(p))) return {ok: false, error: "스킬 폴더가 없습니다 — 지워졌거나 옮겨졌습니다"};
    try {
        const mtimeMs = await writeFileAtomic(p, content);
        host.changed();
        return {ok: true, mtimeMs};
    } catch (e) {
        return {ok: false, error: (e as Error).message};
    }
}

// ── 새 스킬 ──

export interface SkillCreateRequest {
    scope: "personal" | "project";
    name: string;
    description: string;
    body: string;
    manualOnly: boolean;
}

export type SkillCreateResult = {ok: true; path: string; name: string} | {ok: false; error: string};

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// YAML 한 줄 값 — 따옴표가 필요 없으면 그대로, 아니면 큰따옴표(JSON 문자열은 YAML 큰따옴표 문자열로도 맞다)
function yamlValue(v: string): string {
    const one = v.replace(/\s*\r?\n\s*/g, " ").trim();
    const plain = /^[^\s"'#&*!|>%@`{}[\],?:-][^#]*$/.test(one) && !/:\s|\s#|:$/.test(one) && !/^(true|false|yes|no|on|off|null|~|[-+]?\d[\d.e+-]*)$/i.test(one);
    return plain ? one : JSON.stringify(one);
}

export function skillTemplate(req: {name: string; description: string; body: string; manualOnly: boolean}): string {
    const lines = ["---", `name: ${req.name}`, `description: ${yamlValue(req.description)}`];
    if (req.manualOnly) lines.push("disable-model-invocation: true");
    lines.push("---", "");
    const body = req.body.replace(/\r\n/g, "\n").trim();
    return `${lines.join("\n")}\n${body ? `${body}\n` : ""}`;
}

export async function createSkill(host: SkillsHost, raw: unknown): Promise<SkillCreateResult> {
    const r = (raw ?? {}) as Partial<SkillCreateRequest>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const description = typeof r.description === "string" ? r.description.replace(/\s*\r?\n\s*/g, " ").trim() : "";
    const body = typeof r.body === "string" ? r.body : "";
    if (r.scope !== "personal" && r.scope !== "project") return {ok: false, error: "어디에 만들지 고르세요"};
    if (!SKILL_NAME_RE.test(name) || name.length > 64) return {ok: false, error: "이름은 영문 소문자·숫자와 -만 씁니다 (예: write-pr)"};
    if (!description) return {ok: false, error: "설명을 적으세요 — Claude는 설명을 보고 언제 쓸지 정합니다"};
    if (description.length > 1024) return {ok: false, error: "설명이 너무 깁니다 (1024자 이하)"};
    if (Buffer.byteLength(body) > MAX_SKILL_BYTES) return {ok: false, error: "본문이 너무 깁니다"};

    let dir: string;
    let base: string;
    if (r.scope === "personal") {
        base = claudeConfigDir();
        dir = personalSkillsDir();
        if (!isDir(base)) return {ok: false, error: `Claude 설정 폴더가 없습니다 (${base})`};
    } else {
        const t = projectTarget(host.cwd);
        if (t.ok === false) return {ok: false, error: t.reason};
        dir = t.dir;
        base = t.base;
        if (!isDir(base)) return {ok: false, error: "프로젝트 폴더가 없습니다"};
    }
    // 이미 있는 명령·스킬 이름은 쓰지 않는다 (같은 이름이면 /이름이 어느 쪽인지 헷갈리고, 내장 명령이면 스킬이 가려진다)
    const commands = await host.commands(false).catch(() => [] as CommandInfo[]);
    const taken = new Set<string>();
    for (const c of commands) {
        taken.add(c.name.slice(1));
        for (const al of c.aliases ?? []) taken.add(al.replace(/^\//, ""));
    }
    if (taken.has(name)) return {ok: false, error: `/${name}은(는) 이미 있는 이름입니다`};
    const folder = path.join(dir, name);
    if (exists(folder)) return {ok: false, error: `같은 이름의 폴더가 이미 있습니다 (${folder})`};

    const file = path.join(folder, "SKILL.md");
    const content = skillTemplate({name, description, body, manualOnly: r.manualOnly === true});
    let madeFolder = false;
    try {
        await fs.promises.mkdir(dir, {recursive: true});
        // 폴더를 새로 만들 때 이미 있으면 실패한다 — 그사이 생긴 같은 이름 스킬을 덮어쓰지 않게
        await fs.promises.mkdir(folder);
        madeFolder = true;
        // 임시 파일에 다 쓴 뒤 link로 붙인다 — 쓰다 만 SKILL.md가 남지 않고, 있는 파일이면 실패해 덮어쓰지 않는다
        const tmp = path.join(folder, `.SKILL.md.${randomUUID().slice(0, 8)}.tmp`);
        try {
            await fs.promises.writeFile(tmp, content, {encoding: "utf8", mode: 0o644, flag: "wx"});
            try {
                await fs.promises.link(tmp, file);
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
                // 하드 링크를 못 거는 디스크 — 없을 때만 만드는 쓰기로
                await fs.promises.writeFile(file, content, {encoding: "utf8", mode: 0o644, flag: "wx"});
            }
        } finally {
            await fs.promises.rm(tmp, {force: true}).catch(() => undefined);
        }
    } catch (e) {
        // 만들다 실패하면 빈 폴더를 남기지 않는다 (비어 있지 않으면 rmdir이 실패해 그대로 둔다)
        if (madeFolder && !exists(file)) await fs.promises.rmdir(folder).catch(() => undefined);
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return {ok: false, error: "같은 이름의 스킬이 이미 있습니다"};
        return {ok: false, error: (e as Error).message};
    }
    const a = accessFor(host.tabId);
    a.editable.add(file);
    a.readable.add(file);
    a.folders.add(folder);
    host.changed();
    return {ok: true, path: file, name};
}

// Finder에서 보기 — 목록에 낸 스킬 파일·폴더만
export function revealSkillPath(tabId: string, raw: unknown): boolean {
    const p = cleanPath(raw);
    const a = access.get(tabId);
    if (!p || !a) return false;
    if (!a.readable.has(p) && !a.folders.has(p) && !folderOf(a, p)) return false;
    if (!exists(p)) return false;
    shell.showItemInFolder(p);
    return true;
}

// Claude가 Write/Edit로 스킬 파일을 고쳤는지 — 그러면 측정을 다시 한다 (main의 noteInstructionEdit에서)
export function isSkillFile(p: string): boolean {
    const sep = path.sep;
    if (p.includes(`${sep}.claude${sep}skills${sep}`) || p.includes(`${sep}.claude${sep}commands${sep}`)) return true;
    const config = claudeConfigDir() + sep;
    return p.startsWith(`${config}skills${sep}`) || p.startsWith(`${config}commands${sep}`);
}
