import {spawn} from "child_process";
import fs from "fs";
import path from "path";

// ── 플러그인 관리 (확장 창의 플러그인 탭) ──
// SDK에는 플러그인을 설치·지우는 API가 없다(reloadPlugins만 있다). 터미널 화면(/plugin)도 SDK에서는 안 된다.
// 그래서 앱이 고른 claude 실행 파일로 셸 명령을 그대로 돌린다 — `claude plugin list|install|enable|disable|uninstall|details`.
// 설정은 터미널의 claude와 같은 곳(~/.claude 또는 CLAUDE_CONFIG_DIR, 레포의 .claude/settings*.json)에 적힌다.
// 실측(CLI 2.1.325): --json을 주면 결과가 stdout의 마지막 JSON 한 줄로 온다(목록은 JSON 전체). 명령 실행형 설치는
// shownCommand(명령·sha256)를 보이고 거절하며, 사람이 확인한 뒤 --accept-command <sha256>로 다시 돌린다.

export interface PluginCliResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    spawnError?: string;
}

export interface PluginCliHandle {
    result: Promise<PluginCliResult>;
    cancel: () => void;
}

const MAX_OUTPUT = 32 * 1024 * 1024; // --available 목록이 2.4MB쯤 — 넉넉히

// stdin은 닫아 둔다: CLI가 비대화형으로 알고 묻지 않는다(명령 실행형 설치는 보여 주기만 하고 거절한다).
export function runPluginCli(claudePath: string, args: string[], cwd: string, timeoutMs: number): PluginCliHandle {
    let cancel: () => void = () => undefined;
    const result = new Promise<PluginCliResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        const child = spawn(claudePath, ["plugin", ...args], {cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"]});
        const finish = (r: Partial<PluginCliResult> & {code: number | null}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({stdout, stderr, timedOut, cancelled, ...r});
        };
        const kill = () => {
            child.kill("SIGTERM");
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 3000).unref();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, timeoutMs);
        cancel = () => {
            cancelled = true;
            kill();
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
            if (stdout.length < MAX_OUTPUT) stdout += d;
        });
        child.stderr.on("data", (d: string) => {
            if (stderr.length < 256 * 1024) stderr += d;
        });
        child.on("error", (e) => finish({code: null, spawnError: e.message}));
        child.on("close", (code) => finish({code}));
    });
    return {result, cancel: () => cancel()};
}

// 목록 명령은 stdout 전체가 JSON, 바꾸는 명령은 마지막 JSON 한 줄(앞에 사람이 읽는 글이 섞일 수 있다)
export function parseCliJson(stdout: string): unknown {
    const text = stdout.trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        // 아래에서 줄 단위로
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("{")) continue;
        try {
            return JSON.parse(line);
        } catch {
            // 다음 줄
        }
    }
    return null;
}

// 플러그인 id(이름@마켓플레이스)·이름 — 인자로 넘기기 전에 모양을 확인한다("-"로 시작하는 값이 옵션으로 읽히지 않게)
const PLUGIN_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function isPluginRef(v: unknown): v is string {
    return typeof v === "string" && v.length <= 200 && PLUGIN_REF.test(v);
}

export type PluginScope = "user" | "project" | "local";

export function isPluginScope(v: unknown): v is PluginScope {
    return v === "user" || v === "project" || v === "local";
}

// 이 폴더에서 "프로젝트"(이 레포)로 보는 곳 — 레포 범위 설치가 적히는 .claude/settings(.local).json의 자리. CLI처럼 위로
// 올라가며 .git을 찾고, 워크트리(.git이 파일)면 원래 체크아웃을 쓴다(워크트리 안에서도 설정은 원래 체크아웃에 적힌다 — CLAUDE.md
// 실측). 레포가 아니면 그 폴더 자신. 화면 안내와 "홈 폴더에는 레포 범위로 설치하지 않기"에만 쓴다.
export function projectRootFor(cwd: string): string {
    let dir = path.resolve(cwd);
    for (;;) {
        const git = path.join(dir, ".git");
        try {
            const st = fs.statSync(git);
            if (st.isDirectory()) return dir;
            const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"));
            const gitdir = m ? path.resolve(dir, m[1].trim()) : "";
            const at = gitdir.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
            return at > 0 ? gitdir.slice(0, at) : dir;
        } catch {
            // 위로
        }
        const up = path.dirname(dir);
        if (up === dir) return path.resolve(cwd);
        dir = up;
    }
}

export function splitPluginId(id: string): {name: string; marketplace: string} {
    const at = id.lastIndexOf("@");
    return at > 0 ? {name: id.slice(0, at), marketplace: id.slice(at + 1)} : {name: id, marketplace: ""};
}

// ── claude plugin details <이름> (설치된 것만 된다) — 글로만 나온다 ──
//   Component inventory: "Skills (17)  a, b, …" / "Hooks (1)  SessionStart  (harness-only — …)" / "MCP servers (1)  figma  (…)"
//   Projected token cost: "Always-on:   ~2,577 tok   added to every session"
//   Per-component: "  figma-use   ~190   ~12.7k" (스킬·에이전트마다 늘 드는 것 / 부를 때 드는 것)
export interface PluginDetails {
    description?: string;
    skills: string[];
    agents: string[];
    hooks: string[];
    mcpServers: string[];
    lspServers: string[];
    alwaysOnTokens: number | null;
    components: {name: string; alwaysOn: string; onInvoke: string}[];
}

const INVENTORY_KEYS: Record<string, keyof Pick<PluginDetails, "skills" | "agents" | "hooks" | "mcpServers" | "lspServers">> = {
    "skills": "skills",
    "agents": "agents",
    "hooks": "hooks",
    "mcp servers": "mcpServers",
    "lsp servers": "lspServers",
};

function tokenNumber(raw: string): number | null {
    const m = /([\d.,]+)\s*(k)?/i.exec(raw);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    return Math.round(m[2] ? n * 1000 : n);
}

export function parsePluginDetails(text: string): PluginDetails | null {
    const out: PluginDetails = {skills: [], agents: [], hooks: [], mcpServers: [], lspServers: [], alwaysOnTokens: null, components: []};
    let seen = false;
    let inComponents = false;
    for (const line of text.split("\n")) {
        const desc = /^\s*Description:\s*(.*)$/.exec(line);
        if (desc) {
            out.description = desc[1].trim() || undefined;
            continue;
        }
        const inv = /^\s*(Skills|Agents|Hooks|MCP servers|LSP servers)\s*\((\d+)\)\s*(.*)$/i.exec(line);
        if (inv) {
            seen = true;
            const key = INVENTORY_KEYS[inv[1].toLowerCase()];
            const items = inv[3]
                .replace(/\s+\([^)]*\)\s*$/, "")
                .split(/,\s*/)
                .map((s) => s.trim())
                .filter(Boolean);
            // 이름이 잘려 나오면(… and N more) 개수만이라도 맞춘다
            const count = Number(inv[2]);
            out[key] = items.length === count ? items : items.concat(Array.from({length: Math.max(0, count - items.length)}, () => ""));
            continue;
        }
        const always = /^\s*Always-on:\s*(.+?)\s*tok/i.exec(line);
        if (always) {
            seen = true;
            out.alwaysOnTokens = tokenNumber(always[1]);
            continue;
        }
        if (/^\s*component\s+always-on\s+on-invoke\s*$/i.test(line)) {
            inComponents = true;
            continue;
        }
        if (inComponents) {
            const row = /^\s+(\S+)\s+(~?[\d.,]+k?|<\s*\d+|—|-)\s+(~?[\d.,]+k?|<\s*\d+|—|-)\s*$/.exec(line);
            if (row) out.components.push({name: row[1], alwaysOn: row[2], onInvoke: row[3]});
            else if (line.trim()) inComponents = false;
        }
    }
    return seen ? out : null;
}

// ── 출처 — 찾아보기의 "출처" 링크 (브라우저로 연다, http(s)만) ──
export interface PluginSource {
    kind: "repo" | "path" | "npm" | "command" | "other";
    text: string; // 화면에 보일 글
    link?: string; // 브라우저로 열 주소
    command?: string; // 명령 실행형 설치의 명령
}

export interface MarketplaceInfo {
    name: string;
    source?: string;
    repo?: string;
    url?: string;
    path?: string;
}

function webFromGit(url: string): string | null {
    const gh = /^(?:https?:\/\/|git@|ssh:\/\/git@)(github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
    if (gh) return `https://${gh[1].toLowerCase()}/${gh[2]}/${gh[3]}`;
    if (/^https:\/\/[^\s]+$/i.test(url.trim())) return url.trim().replace(/\.git$/, "");
    return null;
}

function treeLink(web: string, ref: string | undefined, sub: string): string {
    const clean = sub.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (!clean) return web;
    return /github\.com|gitlab\.com/.test(web) ? `${web}/tree/${ref || "HEAD"}/${clean}` : web;
}

export function describePluginSource(source: unknown, marketplace: MarketplaceInfo | undefined): PluginSource {
    if (typeof source === "string") {
        // 마켓플레이스 저장소 안의 폴더
        if (marketplace?.repo) {
            const web = `https://github.com/${marketplace.repo}`;
            return {kind: "repo", text: `${marketplace.repo} · ${source.replace(/^\.\//, "")}`, link: treeLink(web, undefined, source)};
        }
        const web = marketplace?.url ? webFromGit(marketplace.url) : null;
        if (web) return {kind: "repo", text: `${web.replace(/^https:\/\//, "")} · ${source.replace(/^\.\//, "")}`, link: treeLink(web, undefined, source)};
        const base = marketplace?.path ? `${marketplace.path.replace(/\/+$/, "")}/` : "";
        return {kind: "path", text: base + source.replace(/^\.\//, "")};
    }
    if (!source || typeof source !== "object") return {kind: "other", text: "알 수 없음"};
    const s = source as {source?: unknown; url?: unknown; repo?: unknown; path?: unknown; ref?: unknown; sha?: unknown; package?: unknown; command?: unknown};
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    switch (s.source) {
        case "github": {
            const repo = str(s.repo);
            if (!repo) break;
            const web = `https://github.com/${repo}`;
            return {kind: "repo", text: repo, link: str(s.ref) ? `${web}/tree/${str(s.ref)}` : web};
        }
        case "url":
        case "git": {
            const url = str(s.url);
            if (!url) break;
            const web = webFromGit(url);
            return {kind: "repo", text: (web ?? url).replace(/^https:\/\//, ""), link: web ?? undefined};
        }
        case "git-subdir": {
            const url = str(s.url);
            if (!url) break;
            const web = webFromGit(url);
            const sub = str(s.path) ?? "";
            return {
                kind: "repo",
                text: `${(web ?? url).replace(/^https:\/\//, "")}${sub ? ` · ${sub}` : ""}`,
                link: web ? treeLink(web, str(s.ref) ?? str(s.sha), sub) : undefined,
            };
        }
        case "npm": {
            const pkg = str(s.package);
            if (!pkg) break;
            return {kind: "npm", text: `npm · ${pkg}`, link: `https://www.npmjs.com/package/${pkg}`};
        }
        case "command": {
            const command = str(s.command);
            return {kind: "command", text: "이 컴퓨터에서 명령을 실행해 설치", command};
        }
        case "directory":
        case "local": {
            const p = str(s.path);
            if (p) return {kind: "path", text: p};
            break;
        }
    }
    return {kind: "other", text: typeof s.source === "string" ? s.source : "알 수 없음"};
}
