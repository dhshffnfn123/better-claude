import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron";
import { createMainWindow } from "./main/windows/create-main-window";
import * as api from "./main/services/api-client";
import {resetCache as resetClaudePathCache, resolveClaudePath, validateClaudeBinary} from "./main/services/claude-path";
import * as settings from "./main/services/settings";
import {expandPathForChildProcesses} from "./main/services/path-expander";
import {loadSdk} from "./main/services/claude-sdk";
import {getGitDiff, getGitStatus} from "./main/services/git-changes";
import type {GitChange, GitStatusResult} from "./main/services/git-changes";
import type {
    McpServerStatus,
    ModelInfo,
    Options,
    PermissionResult,
    PermissionUpdate,
    Query,
    RewindFilesResult,
    SDKControlInitializeResponse,
    SDKMessage,
    SDKUserMessage,
    SessionMessage,
    SlashCommand as SdkSlashCommand,
} from "./main/services/claude-sdk";

// 앱 import 직후 즉시 호출 — 모든 자식 프로세스 spawn 전에 PATH가 확장돼야 함
expandPathForChildProcesses();
import os from "os";
import fs from "fs";
import path from "path";
import {randomUUID} from "crypto";

let sessionId: string | null = null;
let skipPermissions = true;
let lastUserMessage = "";
let currentCwd: string = os.homedir();
// 아래 채팅 설정의 기본값. 앱 시작 시 settings.json에 저장된 값으로 덮어쓴다(loadChatSettings).
let currentModel = "claude-opus-5-5";
let currentEffort = "xhigh";
let ultracode = false;
let fastMode = false;
let systemPrompts: string[] = [];

function loadChatSettings() {
    const saved = settings.load();
    if (typeof saved.model === "string" && saved.model) currentModel = saved.model;
    if (typeof saved.effort === "string" && saved.effort) currentEffort = saved.effort;
    if (typeof saved.ultracode === "boolean") ultracode = saved.ultracode;
    if (typeof saved.fastMode === "boolean") fastMode = saved.fastMode;
    if (Array.isArray(saved.systemPrompts)) {
        systemPrompts = saved.systemPrompts.filter((p): p is string => typeof p === "string");
    }
}

// DB 기록용 세션별 상태
const ensuredSessions = new Set<string>();
const nextMessageIndex = new Map<string, number>();

async function recordTokenUsage(sid: string, inputTokens: number, outputTokens: number) {
    try {
        if (!ensuredSessions.has(sid)) {
            const title = lastUserMessage.slice(0, 60) || "새 대화";
            await api.createConversation({ sessionId: sid, title, cwd: currentCwd });
            const existing = await api.getTokenUsages(sid);
            nextMessageIndex.set(sid, existing.length);
            ensuredSessions.add(sid);
        }
        const idx = nextMessageIndex.get(sid) ?? 0;
        const saved = await api.postTokenUsage(sid, {
            messageIndex: idx,
            model: currentModel,
            effort: effectiveEffort(),
            inputTokens,
            outputTokens,
        });
        if (saved) nextMessageIndex.set(sid, idx + 1);
    } catch (e) {
        console.error("[api] token usage 기록 실패", e);
    }
}

// ultracode는 xhigh 고정 모드라(CLI의 /effort 메뉴 설명 그대로 "xhigh + dynamic
// workflow orchestration"), 켜져 있으면 드롭다운 값 대신 xhigh를 쓴다.
function effectiveEffort(): string {
    return ultracode ? "xhigh" : currentEffort;
}

// 턴을 시작하지 않는 query. 아무것도 yield하지 않는 입력 스트림이라 CLI는 초기화만 하고 기다린다.
// 모델/명령 목록, MCP 상태, 파일 되돌리기처럼 대화 없이 CLI에 물을 때 쓴다.
async function openIdleQuery(options: Options): Promise<{q: Query; close: () => void}> {
    const {query} = await loadSdk();
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => {
        release = r;
    });
    // eslint-disable-next-line require-yield
    const idle = (async function* () {
        await released;
    })() as AsyncIterable<SDKUserMessage>;
    const q = query({prompt: idle, options});
    return {
        q,
        close: () => {
            release();
            q.close();
        },
    };
}

// ── 작업 폴더별 CLI 정보: 명령 목록·모델 목록·MCP 상태 ──
// 프로젝트 명령(스킬·플러그인 포함)과 MCP 서버는 폴더마다 달라서 폴더 단위로 캐시한다.
interface FolderInfo {
    init: Promise<SDKControlInitializeResponse | null>;
    mcp: Promise<McpServerStatus[] | null>;
}

const folderInfo = new Map<string, FolderInfo>();
// MCP 서버는 초기화 직후 대부분 pending이다. 연결이 끝날 때까지 이만큼 기다린다.
const MCP_SETTLE_MS = 10_000;

async function settleMcp(q: Query): Promise<McpServerStatus[]> {
    const deadline = Date.now() + MCP_SETTLE_MS;
    for (;;) {
        const status = await withTimeout(q.mcpServerStatus(), 5000);
        if (!status.some((m) => m.status === "pending") || Date.now() > deadline) return status;
        await new Promise((r) => setTimeout(r, 1000));
    }
}

function probeFolder(cwd: string, refresh = false): FolderInfo {
    const cached = folderInfo.get(cwd);
    if (cached && !refresh) return cached;
    const claudePath = resolveClaudePath();
    if (!claudePath) return {init: Promise.resolve(null), mcp: Promise.resolve(null)};

    const opened = openIdleQuery({pathToClaudeCodeExecutable: claudePath, cwd});
    const init = opened
        .then(({q}) => withTimeout(q.initializationResult(), 30_000))
        .catch((e) => {
            console.error("[probe] 초기화 정보 조회 실패", e);
            return null;
        });
    const mcp = opened
        .then(async ({q}) => ((await init) ? settleMcp(q) : null))
        .catch((e) => {
            console.error("[probe] MCP 상태 조회 실패", e);
            return null;
        });
    void Promise.allSettled([init, mcp]).then(() => opened.then((o) => o.close()).catch(() => undefined));

    const info: FolderInfo = {init, mcp};
    folderInfo.set(cwd, info);
    // 실패는 캐시하지 않는다 — 다음 요청에서 다시 시도
    void init.then((r) => {
        if (!r && folderInfo.get(cwd) === info) folderInfo.delete(cwd);
    });
    return info;
}

// CLI가 지원하는 모델 목록. 실패하면 null → 렌더러가 내장 목록으로 대체한다.
let modelCache: ModelInfo[] | null = null;

async function loadModels(): Promise<ModelInfo[] | null> {
    if (modelCache) return modelCache;
    const init = await probeFolder(currentCwd).init;
    if (init?.models?.length) modelCache = init.models;
    return modelCache;
}

interface AppSlashCommand {
    name: string;
    description: string;
    argumentHint?: string;
    source: "builtin" | "custom";
}

// 이름이 겹치면 CLI 내장 명령이 실행되므로 내장 쪽을 남긴다. 사용자/프로젝트/플러그인 명령을 위로.
function toCommandList(commands: SdkSlashCommand[]): AppSlashCommand[] {
    const byName = new Map<string, AppSlashCommand>();
    for (const c of commands) {
        const name = "/" + c.name;
        const existing = byName.get(name);
        if (existing && existing.source === "builtin") continue;
        byName.set(name, {
            name,
            description: c.description,
            argumentHint: c.argumentHint || undefined,
            source: c.builtin ? "builtin" : "custom",
        });
    }
    return [...byName.values()].sort((a, b) => (a.source === b.source ? 0 : a.source === "custom" ? -1 : 1));
}

interface AppMcpServer {
    name: string;
    status: McpServerStatus["status"];
    error?: string;
    scope?: string;
    toolCount: number;
}

function toMcpList(status: McpServerStatus[] | null): AppMcpServer[] {
    return (status ?? []).map((m) => ({
        name: m.name,
        status: m.status,
        error: m.error,
        scope: m.scope,
        toolCount: m.tools?.length ?? 0,
    }));
}

async function loadCommands(): Promise<AppSlashCommand[]> {
    // 살아 있는 세션이 있으면 그쪽이 최신이다(작업 중 발견된 스킬까지 반영)
    if (live && !live.inputEnded) {
        try {
            return toCommandList(await withTimeout(live.q.supportedCommands(), 5000));
        } catch {
            // 아래 폴더 정보로 대체
        }
    }
    const init = await probeFolder(currentCwd).init;
    return toCommandList(init?.commands ?? []);
}

async function loadMcpStatus(refresh = false): Promise<AppMcpServer[]> {
    if (live && !live.inputEnded && !refresh) {
        try {
            return toMcpList(await withTimeout(live.q.mcpServerStatus(), 5000));
        } catch {
            // 아래 폴더 정보로 대체
        }
    }
    return toMcpList(await probeFolder(currentCwd, refresh).mcp);
}

// 작업 폴더가 바뀌면 그 폴더의 명령/MCP 목록을 렌더러에 밀어 준다
function pushFolderInfo(sender: Electron.WebContents) {
    const cwd = currentCwd;
    void loadCommands().then((list) => {
        if (cwd === currentCwd) sender.send("chat:commands", list);
    });
    void loadMcpStatus().then((list) => {
        if (cwd === currentCwd) sender.send("chat:mcp", list);
    });
}

// 별칭(opus/sonnet…)이 아니라 실제 모델 ID로 비교한다
function currentModelInfo(): ModelInfo | undefined {
    return modelCache?.find((m) => (m.resolvedModel ?? m.value) === currentModel || m.value === currentModel);
}

// 목록을 아직 못 받았으면 지원한다고 가정하고 CLI 판단에 맡긴다
function modelSupportsEffort(): boolean {
    const info = currentModelInfo();
    return !info || info.supportsEffort === true;
}

function modelSupportsAdaptiveThinking(): boolean {
    const info = currentModelInfo();
    return !info || info.supportsAdaptiveThinking === true;
}

function modelSupportsFastMode(): boolean {
    const info = currentModelInfo();
    return !info || info.supportsFastMode === true;
}

// CLI 실패를 렌더러까지 전달하기 위한 페이로드.
// level=error는 응답이 없었다는 뜻, warning은 응답은 왔지만 CLI가 뭔가 경고한 경우.
interface ChatNotice {
    level: "error" | "warning";
    message: string;
    detail?: string;
}

interface ImageData {
    data: string;
    mediaType: string;
}

const MENTION_IGNORE_DIRS = new Set([
    "node_modules", ".git", "dist", "out", ".vite", "build", ".next",
    "coverage", ".cache", ".idea", ".vscode", "vendor", "target",
]);

// @ 멘션 자동완성용: 작업 디렉토리를 순회하며 query에 매칭되는 상대경로를 반환.
// 큰 저장소에서도 멈추지 않도록 방문 수/결과 수에 상한을 둔다.
function searchFilesInCwd(query: string, limit = 50): string[] {
    const root = currentCwd;
    const q = query.toLowerCase();
    const results: string[] = [];
    let visited = 0;
    const MAX_VISIT = 8000;

    const walk = (dir: string) => {
        if (results.length >= limit || visited >= MAX_VISIT) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= limit || visited >= MAX_VISIT) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith(".") || MENTION_IGNORE_DIRS.has(entry.name)) continue;
                walk(full);
            } else if (entry.isFile()) {
                visited++;
                const rel = path.relative(root, full);
                if (!q || rel.toLowerCase().includes(q)) results.push(rel);
            }
        }
    };
    walk(root);

    results.sort((a, b) => {
        const am = a.slice(a.lastIndexOf("/") + 1).toLowerCase().includes(q) ? 0 : 1;
        const bm = b.slice(b.lastIndexOf("/") + 1).toLowerCase().includes(q) ? 0 : 1;
        if (am !== bm) return am - bm;
        return a.length - b.length;
    });
    return results.slice(0, limit);
}

// 권한 모달에 "무엇에 대한 요청인지"를 보여주려고 입력에서 대표 문자열을 뽑는다.
// 실측상 SDK 경로에서는 title/blockedPath가 비어 오고 displayName은 도구 이름뿐이라
// 이게 없으면 "Write 실행을 허용할까요?"만 뜨고 대상 파일이 안 보인다.
function describeToolInput(input: Record<string, unknown>): string {
    for (const key of ["file_path", "path", "command", "pattern", "query", "url"]) {
        const v = input[key];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
}

interface AskQuestion {
    question: string;
    header: string;
    multiSelect?: boolean;
    options: {label: string; description?: string}[];
}

// AskUserQuestion 도구의 input을 화면에 띄울 수 있는 형태로 정리한다.
function parseQuestions(input: Record<string, unknown>): AskQuestion[] | null {
    const raw = input.questions;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const out: AskQuestion[] = [];
    for (const q of raw) {
        if (!q || typeof q !== "object") continue;
        const obj = q as Record<string, unknown>;
        const options = Array.isArray(obj.options)
            ? obj.options
                  .map((o) => {
                      const oo = (o ?? {}) as Record<string, unknown>;
                      return {
                          label: typeof oo.label === "string" ? oo.label : "",
                          description: typeof oo.description === "string" ? oo.description : undefined,
                      };
                  })
                  .filter((o) => o.label)
            : [];
        if (typeof obj.question !== "string" || options.length === 0) continue;
        out.push({
            question: obj.question,
            header: typeof obj.header === "string" ? obj.header : "",
            multiSelect: obj.multiSelect === true,
            options,
        });
    }
    return out.length > 0 ? out : null;
}

// 답변은 tool_result로 모델에게 전달된다. 영어 라벨을 그대로 실어 보낸다.
function formatQuestionAnswers(questions: AskQuestion[], answers: string[][]): string {
    const lines = questions.map((q, i) => {
        const picked = (answers[i] ?? []).filter(Boolean);
        const label = q.header || q.question;
        return `- ${label}: ${picked.length > 0 ? picked.join(", ") : "(skipped)"}`;
    });
    return `The user answered:\n${lines.join("\n")}`;
}

type PendingPermission = (result: PermissionResult) => void;
const pendingPermissions = new Map<string, PendingPermission>();
// "이 대화에서 항상 허용"을 고를 때 CLI에 되돌려 줄 규칙 제안
const pendingSuggestions = new Map<string, PermissionUpdate[]>();

// "이 대화에서 항상 허용"한 규칙. CLI의 세션 규칙은 프로세스가 끝나면 사라지는데
// 앱은 턴마다 프로세스를 새로 띄우므로, 대화(세션 ID)별로 모아 두었다가 매번 옵션으로 다시 넘긴다.
// 다른 대화를 열었다 돌아와도 유지되고, 앱을 끄면 사라진다(터미널 claude의 세션 규칙과 같다).
interface SessionGrants {
    tools: string[];
    directories: string[];
    // Write/Edit 권한에 CLI가 제안하는 "파일 편집 자동 허용"(acceptEdits 모드)
    acceptEdits: boolean;
}

const grantsBySession = new Map<string, SessionGrants>();
// 세션 ID가 아직 없는 새 대화에서 허용한 것. ID가 정해지면 grantsBySession으로 옮긴다.
let unsavedGrants: SessionGrants = emptyGrants();

function emptyGrants(): SessionGrants {
    return {tools: [], directories: [], acceptEdits: false};
}

function currentGrants(): SessionGrants {
    if (!sessionId) return unsavedGrants;
    let g = grantsBySession.get(sessionId);
    if (!g) {
        g = emptyGrants();
        grantsBySession.set(sessionId, g);
    }
    return g;
}

// 새 대화의 첫 응답에서 세션 ID가 정해질 때 호출한다
function adoptUnsavedGrants(sid: string) {
    const g = unsavedGrants;
    unsavedGrants = emptyGrants();
    if (g.tools.length > 0 || g.directories.length > 0 || g.acceptEdits) grantsBySession.set(sid, g);
}

function formatRule(r: {toolName: string; ruleContent?: string}): string {
    return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
}

// 허용 규칙과 디렉토리 추가만 "항상 허용"으로 다룬다. 파일 설정(userSettings 등)에
// 기록되지 않도록 대상은 항상 session으로 바꾼다.
function toSessionUpdates(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
    const out: PermissionUpdate[] = [];
    for (const u of suggestions ?? []) {
        if ((u.type === "addRules" || u.type === "replaceRules") && u.behavior === "allow") {
            out.push({type: "addRules", rules: u.rules, behavior: "allow", destination: "session"});
        } else if (u.type === "addDirectories") {
            out.push({type: "addDirectories", directories: u.directories, destination: "session"});
        } else if (u.type === "setMode" && u.mode === "acceptEdits") {
            out.push({type: "setMode", mode: "acceptEdits", destination: "session"});
        }
    }
    return out;
}

// 모달에 "무엇을 항상 허용하게 되는지" 보여줄 문구
function describeUpdates(updates: PermissionUpdate[]): string[] {
    const out: string[] = [];
    for (const u of updates) {
        if (u.type === "addRules") out.push(...u.rules.map(formatRule));
        else if (u.type === "addDirectories") out.push(...u.directories.map((d) => `디렉토리 접근: ${d}`));
        else if (u.type === "setMode" && u.mode === "acceptEdits") out.push("파일 편집 자동 허용");
    }
    return out;
}

function rememberSessionUpdates(updates: PermissionUpdate[]) {
    const g = currentGrants();
    for (const u of updates) {
        if (u.type === "addRules") {
            for (const r of u.rules) {
                const rule = formatRule(r);
                if (!g.tools.includes(rule)) g.tools.push(rule);
            }
        } else if (u.type === "addDirectories") {
            for (const d of u.directories) {
                if (!g.directories.includes(d)) g.directories.push(d);
            }
        } else if (u.type === "setMode" && u.mode === "acceptEdits") {
            g.acceptEdits = true;
        }
    }
}
const pendingQuestions = new Map<string, AskQuestion[]>();
let permissionSeq = 0;

// canUseTool 콜백 → 렌더러에 물어보고 답이 올 때까지 기다린다.
// SDK는 스트리밍 입력 모드에서만 이 제어 요청을 보낼 수 있다(아래 InputQueue 참고).
function askPermission(
    sender: Electron.WebContents,
    toolName: string,
    input: Record<string, unknown>,
    opts: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        title?: string;
        displayName?: string;
        blockedPath?: string;
        decisionReason?: string;
    }
): Promise<PermissionResult> {
    // AskUserQuestion은 권한이 아니라 질문이다. CLI는 이 도구를 스스로 실행해
    // 터미널에 선택지를 그리는데, 헤드리스에서는 그릴 곳이 없어
    // "The user did not answer the questions."로 끝난다.
    // 그래서 앱이 직접 물어보고, 답을 tool_result 자리에 실어 보낸다.
    const questions = toolName === "AskUserQuestion" ? parseQuestions(input) : null;

    // 전체 허용 모드에서는 질문 말고는 묻지 않는다. 이 모드에서 CLI는 일반 도구를 콜백 없이
    // 자동 허용하지만, 혹시 콜백으로 오는 도구가 있거나 응답 도중 방패를 "전체 허용"으로
    // 바꾼 경우에도 창을 띄우지 않고 바로 허용한다.
    if (!questions && skipPermissions) return Promise.resolve({behavior: "allow"});

    return new Promise((settle) => {
        const id = `perm-${++permissionSeq}`;
        pendingPermissions.set(id, settle);

        if (questions) {
            pendingQuestions.set(id, questions);
            sender.send("chat:question_request", {id, questions});
            opts.signal.addEventListener("abort", () => {
                if (pendingPermissions.delete(id)) {
                    pendingQuestions.delete(id);
                    sender.send("chat:permission_resolved", {id});
                    settle({behavior: "deny", message: "The user did not answer the questions."});
                }
            });
            return;
        }

        const updates = toSessionUpdates(opts.suggestions);
        if (updates.length > 0) pendingSuggestions.set(id, updates);
        sender.send("chat:permission_request", {
            id,
            toolName,
            alwaysAllow: describeUpdates(updates),
            title: opts.title,
            displayName: opts.displayName,
            blockedPath: opts.blockedPath,
            decisionReason: opts.decisionReason,
            target: opts.blockedPath || describeToolInput(input),
            input,
        });
        // 턴이 취소되면 모달이 영원히 남지 않도록 정리
        opts.signal.addEventListener("abort", () => {
            if (pendingPermissions.delete(id)) {
                pendingSuggestions.delete(id);
                sender.send("chat:permission_resolved", {id});
                settle({behavior: "deny", message: "요청이 취소되었습니다"});
            }
        });
    });
}

function buildExtraArgs(): Record<string, string | null> {
    const extra: Record<string, string | null> = {};
    // --effort ultracode는 CLI가 거부한다. 세션 설정 키로 넘겨야 한다.
    // fastMode도 같은 설정 레이어 키라 한 JSON에 같이 싣는다(--settings는 하나뿐).
    const overlay: Record<string, boolean> = {};
    if (ultracode) overlay.ultracode = true;
    if (fastMode && modelSupportsFastMode()) overlay.fastMode = true;
    if (Object.keys(overlay).length > 0) extra.settings = JSON.stringify(overlay);
    return extra;
}

// ── 라이브 세션 ──────────────────────────────────────────────────────────────
// 백그라운드 작업(run_in_background Bash, 백그라운드 에이전트, ultracode 워크플로)이 남아 있으면
// CLI는 result를 보낸 뒤에도 끝나지 않는다. 작업이 끝날 때까지 기다렸다가 후속 턴을 스스로
// 한 번 더 돌리고서야 종료한다(실측: result 5.5초, 프로세스 종료 31.9초).
// 예전처럼 "query 종료 = 턴 종료"로 보면 그동안 UI가 응답 중에 묶이고, 끝나지 않는 작업
// (dev 서버, watch 등)이면 영원히 안 끝난다.
// 그래서 턴 종료는 result로 판단하고, 백그라운드 작업이 있는 동안에는 query를 살려 둔다.
// 그 사이 보낸 메시지는 같은 프로세스로 들어가고, CLI가 스스로 시작한 후속 턴은
// chat:turn_start로 렌더러에 새 응답으로 띄운다.

interface InputQueue {
    stream: AsyncIterable<SDKUserMessage>;
    push: (m: SDKUserMessage) => void;
    end: () => void;
}

// 턴마다 메시지를 밀어 넣을 수 있는 입력 스트림. end() 전까지는 열려 있어야 한다 —
// 닫혀 있으면 CLI가 권한을 물어봐도 답을 되돌려 보낼 수 없어 자동 거부된다.
function createInputQueue(): InputQueue {
    const items: SDKUserMessage[] = [];
    let wake: () => void = () => undefined;
    let ended = false;
    const stream = (async function* () {
        for (;;) {
            while (items.length > 0) yield items.shift() as SDKUserMessage;
            if (ended) return;
            await new Promise<void>((r) => {
                wake = r;
            });
            wake = () => undefined;
        }
    })();
    return {
        stream,
        push: (m) => {
            items.push(m);
            wake();
        },
        end: () => {
            ended = true;
            wake();
        },
    };
}

interface LiveSession {
    q: Query;
    input: InputQueue;
    inputEnded: boolean;
    sender: Electron.WebContents;
    key: string;
    turnActive: boolean;
    turnResolve: (() => void) | null;
    // 이번 턴에 보낸 사용자 메시지의 uuid. 자동 후속 턴이면 null.
    turnUuid: string | null;
    backgroundTasks: number;
    // 백그라운드 작업 상세 — 상단 "백그라운드 N" 패널에 보여준다
    bgMembers: Map<string, BgMember>; // 지금 살아 있는 작업 (background_tasks_changed 기준)
    taskInfo: Map<string, TaskDetail>; // task_started/progress/updated로 모은 정보
    toolInputs: Map<string, unknown>; // tool_use id → 입력 (셸 작업의 명령을 찾으려고)
    outputFiles: Map<string, string>; // 셸 작업 id → CLI가 출력을 쓰는 파일
    idleTimer: ReturnType<typeof setTimeout> | null;
    errorSent: boolean;
    stderrTail: string;
    stopped: boolean;
    ended: Promise<void>;
}

let live: LiveSession | null = null;

interface BgMember {
    type: string;
    description: string;
    subagentType?: string;
    parentTaskId?: string;
    ambient?: boolean;
}

// 에이전트가 최근에 쓴 도구 (서브에이전트 메시지에서)
interface ToolStep {
    id: string;
    name: string;
    target: string;
    status: "running" | "done" | "error";
}

const RECENT_TOOL_STEPS = 6;

interface TaskDetail {
    recentTools?: ToolStep[];
    toolUseId?: string;
    prompt?: string;
    workflowName?: string;
    subagentType?: string;
    startedAt: number;
    activity?: string; // task_progress.description — 지금 하는 일
    summary?: string; // 에이전트 진행 요약 (agentProgressSummaries)
    toolUses?: number;
    totalTokens?: number;
    lastToolName?: string;
}

// ── 작업 파일 패널(오른쪽) ────────────────────────────────────────────────
// Claude가 이 대화에서 고친 파일. 서브에이전트가 고친 것도 포함하고, 실패한 수정(오류 tool_result)은 뺀다.
// 대화를 바꾸면 비우고, 저장된 대화를 열면 세션 기록에서 다시 계산한다.
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MAX_HUNK_CHARS = 200_000;
const MAX_HUNKS_PER_FILE = 50;

interface FileHunk {
    tool: string;
    oldText: string;
    newText: string;
    at: number;
}

interface ChangedFileInfo {
    path: string;
    edits: number;
    lastTurn: number; // 몇 번째 응답에서 마지막으로 바뀌었나 — "방금 바뀐 파일" 표시용
    lastAt: number;
    hunks: FileHunk[];
}

const changedFiles = new Map<string, ChangedFileInfo>();
let fileTurn = 0;
// 결과가 오기 전의 수정 시도 (tool_use id → 내용). 성공 결과가 오면 changedFiles에 반영한다.
const pendingEdits = new Map<string, {path: string; hunks: Omit<FileHunk, "at">[]}>();

function clipText(text: unknown): string {
    const s = typeof text === "string" ? text : "";
    return s.length > MAX_HUNK_CHARS ? s.slice(0, MAX_HUNK_CHARS) + "\n… (너무 길어서 생략)" : s;
}

// CLI는 작업 폴더의 실제 경로로 일한다(/tmp → /private/tmp 같은 심볼릭 링크가 풀린 경로).
// 패널의 트리는 앱이 아는 작업 폴더 경로로 그리므로, 그 안의 파일이면 같은 표기로 맞춘다.
function toCwdPath(abs: string): string {
    const realCwd = realOrResolved(currentCwd);
    if (realCwd !== currentCwd && isInside(realCwd, abs)) return path.join(currentCwd, path.relative(realCwd, abs));
    return abs;
}

function editOf(name: string, input: unknown): {path: string; hunks: Omit<FileHunk, "at">[]} | null {
    if (!EDIT_TOOLS.has(name) || !input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const p = typeof o.file_path === "string" ? o.file_path : typeof o.notebook_path === "string" ? o.notebook_path : "";
    if (!p) return null;
    const abs = toCwdPath(path.resolve(currentCwd, p));
    if (name === "Edit") return {path: abs, hunks: [{tool: name, oldText: clipText(o.old_string), newText: clipText(o.new_string)}]};
    if (name === "Write") return {path: abs, hunks: [{tool: name, oldText: "", newText: clipText(o.content)}]};
    if (name === "MultiEdit") {
        const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [];
        return {path: abs, hunks: edits.map((e) => ({tool: name, oldText: clipText(e?.old_string), newText: clipText(e?.new_string)}))};
    }
    return {path: abs, hunks: [{tool: name, oldText: "", newText: clipText(o.new_source)}]};
}

// 메시지에서 파일 수정을 찾는다: 도구 호출을 기억해 두었다가 결과가 성공이면 반영. 바뀌었으면 true.
// 세션 기록(SessionMessage)도 같은 모양(type/message/parent_tool_use_id)이라 그대로 넣어도 된다.
// at: 수정 시각. 실시간이면 지금, 세션 기록에서 다시 계산할 때는 그 항목의 시각(entryTime).
function trackFileEdits(msg: {type: string; message?: unknown}, at = Date.now()): boolean {
    const content = (msg.message as {content?: unknown} | undefined)?.content;
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const b of content as {type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean}[]) {
        if (msg.type === "assistant" && b.type === "tool_use" && b.id && b.name) {
            const e = editOf(b.name, b.input);
            if (e) pendingEdits.set(b.id, e);
        }
        if (msg.type === "user" && b.type === "tool_result" && b.tool_use_id) {
            const p = pendingEdits.get(b.tool_use_id);
            if (!p) continue;
            pendingEdits.delete(b.tool_use_id);
            if (b.is_error) continue;
            const f = changedFiles.get(p.path) ?? {path: p.path, edits: 0, lastTurn: fileTurn, lastAt: at, hunks: []};
            f.edits += 1;
            f.lastTurn = fileTurn;
            f.lastAt = at;
            f.hunks = [...f.hunks, ...p.hunks.map((h) => ({...h, at}))].slice(-MAX_HUNKS_PER_FILE);
            changedFiles.set(p.path, f);
            changed = true;
        }
    }
    return changed;
}

function changedFileList() {
    return {
        turn: fileTurn,
        files: [...changedFiles.values()].map((f) => ({path: f.path, edits: f.edits, lastTurn: f.lastTurn, lastAt: f.lastAt})),
    };
}

function sendChangedFiles(sender: Electron.WebContents) {
    sender.send("files:changed", changedFileList());
}

// 비울 때마다 올린다 — 세션 기록을 읽는 동안 다른 대화로 옮겼으면 그 결과를 버리기 위해
let changedFilesGen = 0;

function resetChangedFiles() {
    changedFiles.clear();
    pendingEdits.clear();
    fileTurn = 0;
    changedFilesGen++;
}

// 세션 기록 항목의 시각. SDK 타입에는 없지만 실제 항목에는 timestamp(ISO 문자열)가 들어 있다(확인함).
// 이걸 안 쓰면 변경 내역의 시각이 전부 "대화를 연 시각"으로 찍혔다(재현됨). 없으면 0 = 모름.
function entryTime(e: unknown): number {
    const t = Date.parse(String((e as {timestamp?: unknown}).timestamp ?? ""));
    return Number.isFinite(t) ? t : 0;
}

// 저장된 대화를 열면 세션 기록에서 고친 파일을 다시 계산한다 (서브에이전트 항목 포함).
// 반영했으면 true. 읽는 사이 새 대화·다른 대화·폴더 변경이 있었으면 아무것도 바꾸지 않고 false.
async function loadChangedFilesFromSession(sid: string): Promise<boolean> {
    resetChangedFiles();
    const gen = changedFilesGen;
    try {
        const {getSessionMessages} = await loadSdk();
        const entries = await getSessionMessages(sid);
        if (gen !== changedFilesGen) return false;
        for (const e of entries) {
            if (e.type === "user" && !e.parent_tool_use_id) {
                const c = (e.message as {content?: unknown} | undefined)?.content;
                const isPrompt = typeof c === "string" || (Array.isArray(c) && !c.some((b) => (b as {type?: string})?.type === "tool_result"));
                if (isPrompt) fileTurn += 1;
            }
            trackFileEdits(e, entryTime(e));
        }
        return true;
    } catch (e) {
        console.error("[files] 세션 기록에서 고친 파일 계산 실패", e);
        return false;
    }
}

function realOrResolved(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

function isInside(base: string, target: string): boolean {
    const rel = path.relative(base, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// 패널이 보여줄 수 있는 경로: 작업 폴더 안, 또는 Claude가 이 대화에서 고친 파일
function canViewPath(p: unknown): p is string {
    if (typeof p !== "string" || !path.isAbsolute(p)) return false;
    if (changedFiles.has(p)) return true;
    return isInside(realOrResolved(currentCwd), realOrResolved(p));
}

const HIDDEN_ENTRIES = new Set([".git", ".DS_Store"]);
const MAX_DIR_ENTRIES = 2000;

function listDir(dir: unknown) {
    if (!canViewPath(dir)) return null;
    try {
        const list = fs
            .readdirSync(dir, {withFileTypes: true})
            .filter((e) => !HIDDEN_ENTRIES.has(e.name))
            .map((e) => {
                const full = path.join(dir, e.name);
                let isDir = e.isDirectory();
                if (e.isSymbolicLink()) {
                    try {
                        isDir = fs.statSync(full).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }
                return {name: e.name, path: full, isDir};
            })
            .sort((a, b) =>
                a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: "base"}) : a.isDir ? -1 : 1
            );
        return {entries: list.slice(0, MAX_DIR_ENTRIES), truncated: list.length > MAX_DIR_ENTRIES};
    } catch {
        return null;
    }
}

const MAX_VIEW_BYTES = 1_000_000;

function readFileForView(p: unknown) {
    if (!canViewPath(p)) return {error: "볼 수 없는 경로입니다"};
    try {
        const st = fs.statSync(p);
        if (!st.isFile()) return {error: "파일이 아닙니다"};
        const len = Math.min(st.size, MAX_VIEW_BYTES);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(p, "r");
        try {
            fs.readSync(fd, buf, 0, len, 0);
        } finally {
            fs.closeSync(fd);
        }
        // 앞부분에 NUL 바이트가 있으면 이진 파일로 본다
        if (buf.subarray(0, Math.min(len, 8000)).includes(0)) return {binary: true, size: st.size};
        return {text: buf.toString("utf8"), truncated: st.size > MAX_VIEW_BYTES, size: st.size};
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" ? {missing: true} : {error: "파일을 읽을 수 없습니다 (권한 등)"};
    }
}

// 이 대화에서 최근에 끝난 백그라운드 작업 (최신순). CLI 프로세스가 끝나도 남도록 세션 밖에 둔다.
// 대화를 바꾸면 비운다(chat:new / resume / 폴더 변경).
interface FinishedTask {
    id: string;
    type: string;
    description: string;
    subagentType?: string;
    workflowName?: string;
    command?: string;
    status: "completed" | "failed" | "stopped";
    summary?: string;
    startedAt?: number;
    endedAt: number;
    totalTokens?: number;
    toolUses?: number;
    exitCode?: number;
    hasOutput: boolean;
    recentTools?: ToolStep[];
    launchedByAgent?: boolean;
}

const MAX_FINISHED = 10;
let finishedTasks: FinishedTask[] = [];
// 끝난 셸 작업의 출력 파일 (작업 id → 경로) — 끝난 뒤에도 출력을 보여주려고
const finishedOutputFiles = new Map<string, string>();

function clearFinishedTasks(sender?: Electron.WebContents) {
    finishedTasks = [];
    finishedOutputFiles.clear();
    sender?.send("chat:background", {running: [], finished: []});
}

// 셸 작업을 백그라운드로 돌리면 tool_result에 출력 파일 경로가 온다(실측)
const BG_OUTPUT_RE = /background with ID: ([\w-]+)\. Output is being written to: (\S+?\.output)/;

function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as {text: unknown}).text) : "")).join("\n");
    }
    return "";
}

// 서브에이전트 메시지의 parent_tool_use_id = 그 에이전트를 띄운 Agent 도구 호출 id = task_started.tool_use_id
function agentTaskFor(s: LiveSession, parentToolUseId: string): TaskDetail | undefined {
    for (const d of s.taskInfo.values()) if (d.toolUseId === parentToolUseId) return d;
    return undefined;
}

// 백그라운드 작업 상세에 쓸 재료를 모은다: 도구 입력(셸 명령), 셸 출력 파일 경로, 에이전트가 쓴 도구.
// 서브에이전트가 띄운 작업도 있어서, 서브에이전트 메시지를 버리기 전에 부른다.
// 화면에 보낼 내용이 바뀌었으면 true — 출력 경로는 작업 시작 이벤트보다 늦게 와서,
// 이때 다시 보내지 않으면 다음 이벤트까지 "출력 없음"으로 남는다(실측).
function recordTaskArtifacts(s: LiveSession, msg: SDKMessage): boolean {
    const content = (msg as {message?: {content?: unknown}}).message?.content;
    if (!Array.isArray(content)) return false;
    const parent = (msg as {parent_tool_use_id?: string | null}).parent_tool_use_id;
    const agent = parent ? agentTaskFor(s, parent) : undefined;
    let changed = false;
    for (const b of content as {type?: string; id?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string; is_error?: boolean}[]) {
        if (msg.type === "assistant" && b.type === "tool_use" && b.id) {
            s.toolInputs.set(b.id, b.input);
            if (agent && b.name) {
                const target = describeToolInput((b.input ?? {}) as Record<string, unknown>);
                agent.recentTools = [...(agent.recentTools ?? []), {id: b.id, name: b.name, target, status: "running" as const}].slice(-RECENT_TOOL_STEPS);
                changed = true;
            }
        }
        if (msg.type === "user" && b.type === "tool_result") {
            const m = toolResultText(b.content).match(BG_OUTPUT_RE);
            if (m) {
                s.outputFiles.set(m[1], m[2]);
                changed = true;
            }
            const step = agent?.recentTools?.find((t) => t.id === b.tool_use_id);
            if (step) {
                step.status = b.is_error ? "error" : "done";
                changed = true;
            }
        }
    }
    return changed;
}

function updateTaskInfo(s: LiveSession, msg: SDKMessage) {
    const m = msg as unknown as {
        subtype: string;
        task_id: string;
        tool_use_id?: string;
        prompt?: string;
        workflow_name?: string;
        subagent_type?: string;
        description?: string;
        summary?: string;
        last_tool_name?: string;
        usage?: {total_tokens?: number; tool_uses?: number};
    };
    const d = s.taskInfo.get(m.task_id) ?? {startedAt: Date.now()};
    if (m.subtype === "task_started") {
        d.toolUseId = m.tool_use_id;
        d.prompt = m.prompt;
        d.workflowName = m.workflow_name;
        d.subagentType = m.subagent_type;
    } else if (m.subtype === "task_progress") {
        d.activity = m.description;
        if (m.summary) d.summary = m.summary;
        d.lastToolName = m.last_tool_name;
        d.toolUses = m.usage?.tool_uses;
        d.totalTokens = m.usage?.total_tokens;
    }
    s.taskInfo.set(m.task_id, d);
}

// 화면에 보낼 백그라운드 작업: 실행 중(내부용 ambient 작업 제외) + 이 대화에서 최근 끝난 것
function sendBackground(s: LiveSession) {
    const list = [...s.bgMembers]
        .filter(([, m]) => !m.ambient)
        .map(([id, m]) => {
            const d = s.taskInfo.get(id);
            const input = d?.toolUseId ? (s.toolInputs.get(d.toolUseId) as {command?: unknown} | undefined) : undefined;
            return {
                id,
                type: m.type,
                description: m.description,
                subagentType: m.subagentType ?? d?.subagentType,
                workflowName: d?.workflowName,
                prompt: d?.prompt,
                command: typeof input?.command === "string" ? input.command : undefined,
                hasOutput: s.outputFiles.has(id),
                startedAt: d?.startedAt,
                activity: d?.activity && d.activity !== m.description ? d.activity : undefined,
                summary: d?.summary,
                toolUses: d?.toolUses,
                totalTokens: d?.totalTokens,
                lastToolName: d?.lastToolName,
                recentTools: d?.recentTools,
                launchedByAgent: !!m.parentTaskId,
            };
        });
    s.sender.send("chat:background", {running: list, finished: finishedTasks});
}

// 백그라운드 작업이 끝났다(task_notification) — 결과를 "최근 끝난 작업"으로 남긴다
function recordFinishedTask(s: LiveSession, msg: SDKMessage) {
    const n = msg as unknown as {
        task_id: string;
        status: FinishedTask["status"];
        summary?: string;
        output_file?: string;
        usage?: {total_tokens?: number; tool_uses?: number; duration_ms?: number};
    };
    const m = s.bgMembers.get(n.task_id);
    // 백그라운드로 돈 작업만 남긴다 (에이전트 안의 일반 명령 같은 건 제외)
    if (!m || m.ambient) return;
    const d = s.taskInfo.get(n.task_id);
    const input = d?.toolUseId ? (s.toolInputs.get(d.toolUseId) as {command?: unknown} | undefined) : undefined;
    const outputFile = s.outputFiles.get(n.task_id);
    if (outputFile) finishedOutputFiles.set(n.task_id, outputFile);
    // 종료 코드: 요약 문구("… failed with exit code 1")에서 먼저 읽는다. 이 시점엔 출력 파일 끝의
    // "[exited with code N]" 줄이 아직 안 쓰였을 수 있다(실측).
    const code =
        n.summary?.match(/exit code (\d+)/) ??
        (outputFile ? readOutputTail(outputFile, 400)?.text.match(/\[exited with code (\d+)\]\s*$/) : null);
    const exitCode = code ? Number(code[1]) : undefined;
    const record: FinishedTask = {
        id: n.task_id,
        type: m.type,
        description: m.description,
        subagentType: m.subagentType ?? d?.subagentType,
        workflowName: d?.workflowName,
        command: typeof input?.command === "string" ? input.command : undefined,
        status: n.status,
        summary: n.summary || undefined,
        startedAt: d?.startedAt,
        endedAt: Date.now(),
        totalTokens: n.usage?.total_tokens ?? d?.totalTokens,
        toolUses: n.usage?.tool_uses ?? d?.toolUses,
        exitCode,
        hasOutput: !!outputFile,
        recentTools: d?.recentTools,
        launchedByAgent: !!m.parentTaskId,
    };
    finishedTasks = [record, ...finishedTasks.filter((f) => f.id !== record.id)].slice(0, MAX_FINISHED);
}

// 셸 작업 출력 파일의 끝부분. 잘린 첫 줄은 버린다(UTF-8 글자가 중간에서 끊길 수 있어서).
function readOutputTail(file: string, maxBytes = 6000): {text: string; truncated: boolean} | null {
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - maxBytes);
        const fd = fs.openSync(file, "r");
        try {
            const buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            let text = buf.toString("utf8");
            if (start > 0) text = text.slice(text.indexOf("\n") + 1);
            return {text, truncated: start > 0};
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

// 중지 버튼이 눌린 횟수. sendTurn이 CLI를 띄우는 도중(await 사이)에 중지되면
// 이 값이 바뀐 걸 보고 턴을 시작하지 않는다.
let stopEpoch = 0;

// 백그라운드 작업이 모두 끝났는데 후속 턴이 시작되지 않으면 이 시간 뒤 프로세스를 정리한다
const IDLE_END_MS = 60_000;

// 첫 메시지를 재생성·편집하면 앞에 이어갈 지점이 없어 새 세션으로 시작한다.
// 새 세션이 실제로 생기면 옛 세션을 지우고(handleSdkMessage), 생기지 못하고 끝나면 되돌린다.
let replaceFirst: {oldSid: string} | null = null;

function restoreReplaceFirst() {
    if (!replaceFirst) return;
    const old = replaceFirst.oldSid;
    replaceFirst = null;
    // 옮겨 둔 허용 규칙도 원래 세션으로 되돌린다
    if (unsavedGrants.tools.length > 0 || unsavedGrants.directories.length > 0 || unsavedGrants.acceptEdits) {
        grantsBySession.set(old, unsavedGrants);
    }
    unsavedGrants = emptyGrants();
    sessionId = old;
}

// 재생성·편집: 버릴 사용자 메시지(replaceUuid) 직전 항목의 uuid를 돌려준다. 세션을 그 지점까지만
// 이어가면(resumeSessionAt) 그 메시지와 이후 응답이 모델 기록에서 빠진다 — 화면에서 지우는 범위와 같다.
// 예전에는 같은 세션에 다시 보내기만 해서 모델에게 옛 질문·답이 그대로 남았다(재현됨).
async function prepareReplace(replaceUuid: string): Promise<string | undefined> {
    if (!sessionId) return undefined;
    let entries: SessionMessage[];
    try {
        const {getSessionMessages} = await loadSdk();
        entries = await getSessionMessages(sessionId);
    } catch (e) {
        console.error("[replace] 세션 기록 조회 실패", e);
        return undefined;
    }
    const idx = entries.findIndex((e) => e.uuid === replaceUuid);
    if (idx < 0) return undefined; // 못 찾으면 예전처럼 이어서 보낸다
    // 서브에이전트 항목은 건너뛰고 본 대화의 직전 항목을 고른다
    for (let i = idx - 1; i >= 0; i--) {
        if (!entries[i].parent_tool_use_id) return entries[i].uuid;
    }
    // 첫 메시지 — 새 세션으로. 이 대화에서 허용한 규칙은 새 세션으로 옮긴다.
    replaceFirst = {oldSid: sessionId};
    unsavedGrants = grantsBySession.get(sessionId) ?? emptyGrants();
    grantsBySession.delete(sessionId);
    sessionId = null;
    return undefined;
}

// query 생성 시점에 고정되는 옵션들. 바뀌면 프로세스를 새로 띄워야 한다.
function optionsKey(): string {
    return JSON.stringify([currentModel, effectiveEffort(), ultracode, fastMode, skipPermissions, currentCwd, systemPrompts]);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${ms}ms 시간 초과`)), ms)),
    ]);
}

function endInput(s: LiveSession) {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.inputEnded = true;
    s.input.end();
}

// 백그라운드 작업도 같이 종료된다
function closeLive() {
    const s = live;
    if (!s) return;
    s.stopped = true;
    endInput(s);
    s.q.close();
}

function settlePendingPermissions(sender: Electron.WebContents, message: string) {
    for (const settle of pendingPermissions.values()) {
        settle({behavior: "deny", message});
    }
    pendingPermissions.clear();
    pendingQuestions.clear();
    pendingSuggestions.clear();
    sender.send("chat:permission_resolved", {id: null});
}

function beginTurn(s: LiveSession, resolve: (() => void) | null, uuid: string | null) {
    streamedMessageIds.clear();
    fileTurn += 1;
    // 패널의 "방금" 표시를 새 응답 기준으로 — 지난 응답에서 바뀐 파일은 "수정 N"으로 내려간다
    if (changedFiles.size > 0) sendChangedFiles(s.sender);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.turnActive = true;
    s.turnResolve = resolve;
    s.turnUuid = uuid;
    s.errorSent = false;
    s.stderrTail = "";
}

function finishTurn(s: LiveSession) {
    if (!s.turnActive) return;
    s.turnActive = false;
    // 첫 메시지 재생성·편집이 새 세션을 만들지 못하고 끝났으면 원래 세션으로 되돌린다
    restoreReplaceFirst();
    // 답을 못 받은 권한 요청이 남아 있으면 렌더러 모달이 영영 안 닫힌다
    settlePendingPermissions(s.sender, "턴이 종료되었습니다");
    s.sender.send("chat:done");
    s.turnResolve?.();
    s.turnResolve = null;
    s.turnUuid = null;
    // 백그라운드 작업이 없으면 입력을 닫는다 — 닫지 않으면 for await가 다음 메시지를 영원히 기다린다
    if (s.backgroundTasks === 0) endInput(s);
}

async function reportContextUsage(s: LiveSession) {
    try {
        // summary: 마지막 응답의 usage로 계산 — 카테고리별 토큰 카운트 API 호출을 생략한다.
        // CLI가 답하지 않아도 턴 종료가 막히지 않도록 시간 제한을 둔다.
        const usage = await withTimeout(s.q.getContextUsage({detail: "summary"}), 5000);
        // 기다리는 사이 중지됐으면 보내지 않는다
        if (s.stopped) return;
        s.sender.send("chat:context", {
            totalTokens: usage.totalTokens,
            maxTokens: usage.rawMaxTokens,
            percentage: usage.percentage,
        });
    } catch (e) {
        console.error("[context] 사용량 조회 실패", e);
    }
}

async function startLive(sender: Electron.WebContents, claudePath: string, resumeAt?: string): Promise<LiveSession> {
    const {query} = await loadSdk();
    const input = createInputQueue();
    const grants = currentGrants();
    let resolveEnded: () => void = () => undefined;
    const ended = new Promise<void>((r) => {
        resolveEnded = r;
    });
    // canUseTool·stderr 콜백이 query 생성 시점에 세션 객체를 참조해야 해서 먼저 만든다
    // eslint-disable-next-line prefer-const
    let s: LiveSession;
    const q = query({
        prompt: input.stream,
        options: {
            model: currentModel,
            effort: modelSupportsEffort() ? (effectiveEffort() as Options["effort"]) : undefined,
            // 5세대 모델은 사고 내용을 기본으로 숨긴다(display: omitted → 빈 문자열).
            // 요약본을 받아야 ActivityPanel에 사고 과정이 보인다.
            // (Haiku 4.5 같은 구모델은 adaptive를 지원하지 않아 CLI 기본값에 맡긴다)
            thinking: modelSupportsAdaptiveThinking() ? {type: "adaptive", display: "summarized"} : undefined,
            cwd: currentCwd,
            // 앱이 이미 찾아둔 바로 그 바이너리를 쓴다. 지정하지 않으면 SDK가
            // 자기 번들 바이너리(224MB)를 쓰므로 인증/버전이 갈릴 수 있다.
            pathToClaudeCodeExecutable: claudePath,
            resume: sessionId ?? undefined,
            // 재생성·편집일 때만: 이 지점까지만 이어간다(그 뒤는 모델 기록에서 빠진다)
            resumeSessionAt: sessionId && resumeAt ? resumeAt : undefined,
            permissionMode: skipPermissions ? "bypassPermissions" : grants.acceptEdits ? "acceptEdits" : "default",
            allowedTools: grants.tools.length > 0 ? [...grants.tools] : undefined,
            additionalDirectories: grants.directories.length > 0 ? [...grants.directories] : undefined,
            // 글자 단위 스트리밍(stream_event). 완성된 assistant 메시지도 따로 온다 — handleSdkMessage 참고
            includePartialMessages: true,
            // 메시지 시점으로 파일을 되돌릴 수 있게 수정 전 백업을 남긴다(rewindFiles)
            enableFileCheckpointing: true,
            // 백그라운드 에이전트가 무엇을 하는지 약 30초마다 한 줄 요약(task_progress.summary).
            // 에이전트의 프롬프트 캐시를 재사용해 비용은 거의 없다(SDK 문서).
            agentProgressSummaries: true,
            // 전체 허용 모드에서도 항상 넘긴다. 콜백이 없으면 CLI가 AskUserQuestion 도구를 아예 빼서
            // Claude가 질문 창을 띄울 수 없다(실측). 전체 허용일 때 일반 도구는 askPermission이 바로 허용한다.
            canUseTool: (toolName, toolInput, opts) =>
                askPermission(s.sender, toolName, toolInput as Record<string, unknown>, opts),
            // snapshot: false가 핵심이다. 기본값(기록)이면 CLI가 대화의 첫 요청 때 시스템 프롬프트를
            // 세션 기록에 고정하고 이후 resume에서는 그걸 그대로 쓴다. 앱은 턴마다 프로세스를 새로
            // 띄워 resume하므로, 대화 도중 추가한 프롬프트는 무시되고 삭제한 프롬프트는 계속 남았다(실측).
            // 프롬프트가 없을 때도 이 형태로 넘겨야 삭제가 반영된다. 캐시 손실은 측정상 없었다.
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined,
                snapshot: false,
            },
            extraArgs: buildExtraArgs(),
            stderr: (data: string) => {
                s.stderrTail = (s.stderrTail + data).slice(-4000);
                console.error("[claude stderr]", data);
            },
        },
    });
    s = {
        q,
        input,
        inputEnded: false,
        sender,
        key: optionsKey(),
        turnActive: false,
        turnResolve: null,
        turnUuid: null,
        backgroundTasks: 0,
        bgMembers: new Map(),
        taskInfo: new Map(),
        toolInputs: new Map(),
        outputFiles: new Map(),
        idleTimer: null,
        errorSent: false,
        stderrTail: "",
        stopped: false,
        ended,
    };
    live = s;
    void pump(s, claudePath).finally(resolveEnded);
    return s;
}

function resultBelongsToTurn(s: LiveSession, msg: SDKMessage): boolean {
    const r = msg as unknown as {
        num_turns: number;
        is_error: boolean;
        user_message_uuid?: string;
        user_message_uuids?: string[];
    };
    if (!s.turnUuid) return s.turnActive; // 자동 후속 턴은 uuid가 없다
    const uuids = r.user_message_uuids ?? (r.user_message_uuid ? [r.user_message_uuid] : null);
    if (uuids) return uuids.includes(s.turnUuid);
    // uuid를 싣지 않는 구버전 CLI — 모델 호출 없는 결과(알림 처리)만 거른다
    return r.num_turns > 0 || r.is_error;
}

// query가 끝날 때까지 메시지를 렌더러로 흘려보낸다. 여러 턴에 걸쳐 돈다.
async function pump(s: LiveSession, claudePath: string) {
    const notify = (notice: ChatNotice) => {
        if (notice.level === "error") s.errorSent = true;
        s.sender.send("chat:error", notice);
    };
    try {
        for await (const msg of s.q) {
            // 중지/정리된 세션 — 프로세스가 끝날 때까지 흘려보내기만 하고 렌더러에는 아무것도 보내지 않는다
            if (s.stopped) continue;

            // 백그라운드 작업 상세용 재료(셸 명령, 출력 파일, 에이전트 도구) — 서브에이전트 메시지를 버리기 전에 모은다
            if (recordTaskArtifacts(s, msg) && s.bgMembers.size > 0) sendBackground(s);
            // 작업 파일 패널: Claude(서브에이전트 포함)가 고친 파일
            if (trackFileEdits(msg)) sendChangedFiles(s.sender);

            // 백그라운드 작업이 끝났다 — 결과를 남긴다 (목록에서 빠지는 건 뒤따르는 background_tasks_changed)
            if (msg.type === "system" && msg.subtype === "task_notification") {
                recordFinishedTask(s, msg);
                sendBackground(s);
                continue;
            }

            // 작업 시작·진행·상태 — 상단 "백그라운드 N" 패널의 상세 정보
            if (
                msg.type === "system" &&
                (msg.subtype === "task_started" || msg.subtype === "task_progress" || msg.subtype === "task_updated")
            ) {
                updateTaskInfo(s, msg);
                if (s.bgMembers.size > 0) sendBackground(s);
                continue;
            }

            // 응답 중이 아닐 때 온 서브에이전트 메시지(백그라운드 에이전트의 작업)는 버린다.
            // 예전에는 이걸 "후속 턴 시작"으로 잘못 봐서, 에이전트가 일하는 내내 화면이
            // 다시 "응답 중"에 묶이고 그 도구들이 새 답변처럼 보였다(재현됨).
            const fromSubagent = !!(msg as {parent_tool_use_id?: string | null}).parent_tool_use_id;
            if (!s.turnActive && fromSubagent) continue;

            // 백그라운드 작업 완료 알림으로 CLI가 스스로 시작한 턴
            if (!s.turnActive && msg.type === "assistant") {
                beginTurn(s, null, null);
                s.sender.send("chat:turn_start");
            }

            if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
                const tasks = (msg as unknown as {
                    tasks: {
                        task_id: string;
                        task_type: string;
                        description: string;
                        subagent_type?: string;
                        parent_task_id?: string;
                        ambient?: boolean;
                    }[];
                }).tasks ?? [];
                s.backgroundTasks = tasks.length;
                // 전체 목록이 온다 — 통째로 바꾼다
                s.bgMembers = new Map(
                    tasks.map((t) => [
                        t.task_id,
                        {
                            type: t.task_type,
                            description: t.description,
                            subagentType: t.subagent_type,
                            parentTaskId: t.parent_task_id,
                            ambient: t.ambient,
                        },
                    ])
                );
                sendBackground(s);
                // 보통은 곧바로 후속 턴이 시작된다. 안 시작되면 일정 시간 뒤 정리한다.
                if (tasks.length === 0 && !s.turnActive && !s.inputEnded) {
                    if (s.idleTimer) clearTimeout(s.idleTimer);
                    s.idleTimer = setTimeout(() => {
                        if (!s.turnActive) endInput(s);
                    }, IDLE_END_MS);
                }
                continue;
            }

            // 이번 턴과 무관한 result는 버린다. 예: 중지된 세션을 재개하면 CLI가 이전 프로세스의
            // 백그라운드 작업 알림을 먼저 처리하며 모델 호출 없는 빈 result(num_turns 0)를 낸다.
            // 이걸 턴 종료로 보면 진짜 답이 오기 전에 턴이 끝나 버린다.
            if (msg.type === "result" && !resultBelongsToTurn(s, msg)) continue;

            handleSdkMessage(s.sender, msg, notify, () => s.stderrTail);

            if (msg.type === "result") {
                // 컨텍스트 사용량은 query가 살아 있을 때만 물을 수 있어서 턴을 닫기 직전에 조회한다
                await Promise.all([reportContextUsage(s), reportMcpStatus(s)]);
                if (s.stopped) continue;
                finishTurn(s);
            }
        }
    } catch (e) {
        // 사용자가 중지했거나 앱이 정리한 경우는 실패가 아니다
        if (!s.stopped && !s.errorSent) {
            const detail = s.stderrTail.trim();
            notify({
                level: "error",
                message: `Claude 실행에 실패했습니다: ${(e as Error).message}`,
                detail: detail || claudePath,
            });
        }
    } finally {
        endInput(s);
        finishTurn(s);
        settlePendingPermissions(s.sender, "세션이 종료되었습니다");
        s.sender.send("chat:background", {running: [], finished: finishedTasks});
        if (live === s) live = null;
    }
}

async function sendTurn(
    sender: Electron.WebContents,
    message: string,
    images: ImageData[],
    replaceUuid?: string
): Promise<void> {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
        sender.send("claude:not_found");
        sender.send("chat:done");
        return;
    }

    // 살아 있는 프로세스를 이어 쓸 수 없으면(입력이 닫혔거나 설정이 바뀜) 끝나길 기다렸다가 새로 띄운다.
    // 설정 변경으로 닫는 경우 백그라운드 작업도 같이 종료된다.
    const epoch = stopEpoch;
    const prev = live;
    // 재생성·편집은 이어갈 지점이 바뀌므로 살아 있는 프로세스를 이어 쓸 수 없다
    if (prev && (replaceUuid || prev.inputEnded || prev.key !== optionsKey())) {
        if (!prev.inputEnded) closeLive();
        await prev.ended;
    }
    const resumeAt = replaceUuid ? await prepareReplace(replaceUuid) : undefined;

    const content: object[] = [{type: "text", text: message}];
    for (const img of images) {
        content.push({
            type: "image",
            source: {type: "base64", media_type: img.mediaType, data: img.data},
        });
    }

    // 렌더러는 중지 즉시 턴을 닫았다. 여기서 시작하면 아무도 안 듣는 턴이 돈다.
    if (epoch !== stopEpoch) {
        restoreReplaceFirst();
        return;
    }

    let s: LiveSession;
    try {
        s = live ?? (await startLive(sender, claudePath, resumeAt));
        if (epoch !== stopEpoch) {
            closeLive();
            return;
        }
    } catch (e) {
        restoreReplaceFirst();
        if (epoch !== stopEpoch) return;
        sender.send("chat:error", {level: "error", message: `Claude 실행에 실패했습니다: ${(e as Error).message}`});
        sender.send("chat:done");
        return;
    }
    s.sender = sender;

    return new Promise<void>((resolve) => {
        const uuid = randomUUID();
        beginTurn(s, resolve, uuid);
        // 파일 되돌리기의 기준점 — 렌더러가 이 사용자 메시지에 붙여 둔다
        sender.send("chat:turn_uuid", {uuid});
        s.input.push({
            uuid,
            type: "user",
            message: {role: "user", content},
            parent_tool_use_id: null,
            session_id: sessionId ?? "",
        } as unknown as SDKUserMessage);
    });
}

async function reportMcpStatus(s: LiveSession) {
    try {
        const status = await withTimeout(s.q.mcpServerStatus(), 5000);
        if (!s.stopped) s.sender.send("chat:mcp", toMcpList(status));
    } catch (e) {
        console.error("[mcp] 상태 조회 실패", e);
    }
}

// ── CLI 세션 기록 → 화면 메시지 ──
interface LoadedTool {
    id: string;
    name: string;
    input: unknown;
    status: "done" | "error";
    resultPreview?: string;
}

type LoadedSegment = {kind: "text"; text: string} | {kind: "tool"; tool: LoadedTool};

interface LoadedMessage {
    role: "user" | "assistant";
    content: string;
    uuid?: string;
    images?: string[];
    segments?: LoadedSegment[];
}

interface ContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
    source?: {type?: string; media_type?: string; data?: string};
}

// 슬래시 명령 실행은 기록에 <command-name>/x</command-name><command-args>…</command-args>로 남는다
function describeCommandEntry(text: string): string | null {
    const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
    if (!name) return null;
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return args ? `${name} ${args}` : name;
}

function sessionToMessages(entries: SessionMessage[]): LoadedMessage[] {
    const out: LoadedMessage[] = [];
    let assistant: LoadedMessage | null = null;
    const tools = new Map<string, LoadedTool>();

    const closeAssistant = () => {
        if (assistant) {
            assistant.content = (assistant.segments ?? [])
                .filter((seg): seg is {kind: "text"; text: string} => seg.kind === "text")
                .map((seg) => seg.text)
                .join("\n\n");
            out.push(assistant);
        }
        assistant = null;
    };

    for (const entry of entries) {
        // 서브에이전트 내부 대화는 본문에 넣지 않는다(라이브 화면과 동일)
        if (entry.parent_tool_use_id) continue;
        const raw = entry.message as {content?: string | ContentBlock[]} | undefined;
        const blocks: ContentBlock[] =
            typeof raw?.content === "string" ? [{type: "text", text: raw.content}] : raw?.content ?? [];

        if (entry.type === "assistant") {
            if (!assistant) assistant = {role: "assistant", content: "", segments: []};
            const segs = assistant.segments as LoadedSegment[];
            for (const b of blocks) {
                if (b.type === "text" && b.text) {
                    const last = segs[segs.length - 1];
                    if (last?.kind === "text") last.text += b.text;
                    else segs.push({kind: "text", text: b.text});
                } else if (b.type === "tool_use" && b.id && b.name) {
                    const tool: LoadedTool = {id: b.id, name: b.name, input: b.input ?? {}, status: "done"};
                    tools.set(b.id, tool);
                    segs.push({kind: "tool", tool});
                }
            }
            continue;
        }

        if (entry.type !== "user") continue;

        // 도구 결과 — 앞선 도구 호출에 붙인다
        let hasToolResult = false;
        for (const b of blocks) {
            if (b.type === "tool_result" && b.tool_use_id) {
                hasToolResult = true;
                const tool = tools.get(b.tool_use_id);
                if (tool) {
                    const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
                    tool.status = b.is_error ? "error" : "done";
                    tool.resultPreview = text.slice(0, 500);
                }
            }
        }
        if (hasToolResult) continue;

        const text = blocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text as string)
            .join("\n");
        if (text.includes("<local-command-stdout>") || text.includes("<local-command-caveat>")) continue;
        const images = blocks
            .filter((b) => b.type === "image" && b.source?.type === "base64" && b.source.data)
            .map((b) => `data:${b.source?.media_type ?? "image/png"};base64,${b.source?.data}`);
        const content = describeCommandEntry(text) ?? text;
        if (!content && images.length === 0) continue;

        closeAssistant();
        out.push({role: "user", content, uuid: entry.uuid, images: images.length > 0 ? images : undefined});
    }
    closeAssistant();
    return out;
}

function handleSdkMessage(
    sender: Electron.WebContents,
    msg: SDKMessage,
    notify: (n: ChatNotice) => void,
    stderrTail: () => string
) {
    const sid = (msg as {session_id?: string}).session_id;
    if (sid && !sessionId) {
        sessionId = sid;
        adoptUnsavedGrants(sid);
        // 첫 메시지 재생성·편집으로 새 세션이 생겼다 — 버린 옛 세션을 지운다(같은 대화가 두 개 남지 않게)
        if (replaceFirst && replaceFirst.oldSid !== sid) {
            const old = replaceFirst.oldSid;
            replaceFirst = null;
            grantsBySession.delete(old);
            void loadSdk()
                .then(({deleteSession}) => deleteSession(old))
                .catch((e) => console.error("[sessions] 옛 세션 삭제 실패", e));
        }
    }
    // 서브에이전트(Agent 도구)가 만든 메시지. 본문에는 넣지 않고 도구 진행만 알린다.
    const parentToolUseId = (msg as {parent_tool_use_id?: string | null}).parent_tool_use_id ?? undefined;

    // 글자 단위 스트리밍. 이 메시지 id를 기억해 두고, 뒤따라오는 완성본에서는
    // 텍스트/사고 블록을 다시 보내지 않는다(중복 방지). 도구 호출은 완성본에서 보낸다.
    if (msg.type === "stream_event") {
        // 서브에이전트의 글자·사고는 본문에 섞지 않는다
        if (parentToolUseId) return;
        const ev = (msg as unknown as {
            event: {type: string; message?: {id?: string}; delta?: {type: string; text?: string; thinking?: string}};
        }).event;
        if (ev.type === "message_start" && ev.message?.id) {
            streamedMessageIds.add(ev.message.id);
        } else if (ev.type === "content_block_delta" && ev.delta) {
            if (ev.delta.type === "text_delta" && ev.delta.text) sender.send("chat:chunk", ev.delta.text);
            else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
                sender.send("chat:thinking", ev.delta.thinking);
            }
        }
        return;
    }

    if (msg.type === "assistant") {
        // 스트리밍으로 이미 보낸 메시지인가. API 오류 메시지처럼 스트림 없이 오는 것도 있다.
        const streamed = !!msg.message?.id && streamedMessageIds.has(msg.message.id);
        const blocks = (msg.message?.content ?? []) as {
            type: string;
            text?: string;
            thinking?: string;
            id?: string;
            name?: string;
            input?: unknown;
        }[];
        for (const block of blocks) {
            if (block.type === "text" && block.text) {
                if (!streamed && !parentToolUseId) sender.send("chat:chunk", block.text);
            } else if (block.type === "thinking" && block.thinking) {
                if (!streamed && !parentToolUseId) sender.send("chat:thinking", block.thinking);
            } else if (block.type === "tool_use" && block.id && block.name) {
                sender.send("chat:tool_use", {
                    id: block.id,
                    name: block.name,
                    input: block.input ?? {},
                    parentToolUseId,
                });
            }
        }
        const usage = msg.message?.usage;
        // 서브에이전트의 토큰 수로 진행 표시가 덮이지 않게 본 대화 것만 보낸다
        if (usage && !parentToolUseId) {
            sender.send("chat:usage", {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
            });
        }
        return;
    }

    if (msg.type === "user") {
        const blocks = (msg.message?.content ?? []) as {
            type: string;
            content?: string | unknown[];
            is_error?: boolean;
            tool_use_id?: string;
        }[];
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
            if (block.type === "tool_result" && block.tool_use_id) {
                const raw =
                    typeof block.content === "string"
                        ? block.content
                        : JSON.stringify(block.content ?? "");
                sender.send("chat:tool_result", {
                    id: block.tool_use_id,
                    isError: !!block.is_error,
                    content: raw.slice(0, 500),
                    parentToolUseId,
                });
            }
        }
        return;
    }

    if (msg.type === "result") {
        const usage = msg.usage as {input_tokens?: number; output_tokens?: number} | undefined;
        const inputTokens = usage?.input_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? 0;
        sender.send("chat:usage", {inputTokens, outputTokens});
        // 세션 누적 예상 비용(재개한 세션은 이전 턴 포함). 청구서가 아니라 추정치.
        if (typeof msg.total_cost_usd === "number") {
            sender.send("chat:cost", {totalCostUsd: msg.total_cost_usd});
        }
        if (sessionId) void recordTokenUsage(sessionId, inputTokens, outputTokens);
        if (msg.is_error) {
            // 에러 결과(SDKResultError)에는 result가 없고, 성공 subtype인데 is_error인 경우에만 있다
            const result = (msg as {result?: unknown}).result;
            const text = typeof result === "string" ? result.trim() : "";
            notify({
                level: "error",
                message: text || `Claude가 오류로 종료했습니다 (${msg.subtype})`,
                detail: stderrTail().trim() || undefined,
            });
        }
        return;
    }

    if (msg.type === "system" && msg.subtype === "commands_changed") {
        const cmds = (msg as unknown as {commands: SdkSlashCommand[]}).commands ?? [];
        sender.send("chat:commands", toCommandList(cmds));
        return;
    }

    if (msg.type === "rate_limit_event") {
        mergeRateLimits((msg as unknown as {rate_limit_info: RateLimitInfo}).rate_limit_info);
        sender.send("chat:rate_limits", rateLimitList());
        return;
    }

    // 재시도 대기 중에는 아무 출력이 없어 멈춘 것처럼 보이므로 알린다
    if (msg.type === "system" && msg.subtype === "api_retry") {
        const r = msg as unknown as {attempt: number; max_retries: number; retry_delay_ms: number; error_status: number | null};
        const status = r.error_status ? ` (HTTP ${r.error_status})` : " (연결 오류)";
        notify({
            level: "warning",
            message: `API 요청 실패${status} — ${Math.ceil(r.retry_delay_ms / 1000)}초 후 재시도합니다 (${r.attempt}/${r.max_retries})`,
        });
        return;
    }

    // 5세대 모델의 안전 분류기가 응답을 거절한 경우
    if (msg.type === "system" && msg.subtype === "model_refusal_fallback") {
        const r = msg as unknown as {
            original_model: string;
            fallback_model: string;
            api_refusal_category?: string | null;
            api_refusal_explanation?: string | null;
        };
        notify({
            level: "warning",
            message: `${r.original_model}이(가) 요청을 거절해 ${r.fallback_model}(으)로 다시 시도했습니다`,
            detail: refusalDetail(r.api_refusal_category, r.api_refusal_explanation),
        });
        return;
    }
    if (msg.type === "system" && msg.subtype === "model_refusal_no_fallback") {
        const r = msg as unknown as {
            original_model: string;
            api_refusal_category?: string | null;
            api_refusal_explanation?: string | null;
        };
        notify({
            level: "error",
            message: `${r.original_model}이(가) 요청을 거절했습니다`,
            detail: refusalDetail(r.api_refusal_category, r.api_refusal_explanation),
        });
        return;
    }

    // 권한 없이 자동 거부된 도구 호출 — 예전에는 오류 문자열을 뒤져 추측하던 부분
    if (msg.type === "system" && msg.subtype === "permission_denied") {
        const denied = msg as unknown as {tool_name?: string; message?: string};
        notify({
            level: "warning",
            message: denied.message ?? `${denied.tool_name ?? "도구"} 실행 권한이 없어 건너뛰었습니다`,
        });
    }
}

// 스트리밍으로 이미 렌더러에 보낸 assistant 메시지 id. 턴이 바뀌면 의미가 없으므로 턴마다 비운다.
const streamedMessageIds = new Set<string>();

// ── 요금제 사용량(claude.ai 구독) ──
// rate_limit_event는 바뀐 한도만 알려줄 수 있어 한도 종류별로 합쳐 둔다.
interface RateLimitWindow {
    utilization?: number; // 0~1
    resetsAt?: number; // epoch 초
    status?: string;
}
interface RateLimitInfo extends RateLimitWindow {
    rateLimitType?: string;
    unifiedWindows?: Record<string, RateLimitWindow>;
}

const rateLimits = new Map<string, RateLimitWindow>();

function mergeRateLimits(info: RateLimitInfo | undefined) {
    if (!info) return;
    if (info.unifiedWindows && Object.keys(info.unifiedWindows).length > 0) {
        for (const [type, w] of Object.entries(info.unifiedWindows)) rateLimits.set(type, {...rateLimits.get(type), ...w});
    } else if (info.rateLimitType) {
        rateLimits.set(info.rateLimitType, {
            ...rateLimits.get(info.rateLimitType),
            utilization: info.utilization,
            resetsAt: info.resetsAt,
            status: info.status,
        });
    }
}

function rateLimitList() {
    return [...rateLimits.entries()].map(([type, w]) => ({type, ...w}));
}

function refusalDetail(category?: string | null, explanation?: string | null): string | undefined {
    const parts = [category ? `분류: ${category}` : "", explanation ?? ""].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
}

// replaceUuid: 재생성·편집일 때 대신할 사용자 메시지의 uuid
ipcMain.handle("chat:send", (event, message: string, images: ImageData[] = [], replaceUuid?: string) => {
    lastUserMessage = message;
    return sendTurn(event.sender, message, images, replaceUuid);
});

// 방패는 기본이 "전체 허용"이고, "확인 모드"는 지금 대화에서만 쓰는 임시 모드다.
// 새 대화·폴더 변경 때 main이 전체 허용으로 되돌리므로, 렌더러는 그 뒤 이 값을 다시 읽어
// 방패 표시를 맞춰야 한다. 예전에는 화면만 "확인 모드"로 남아 묻지 않고 실행되는 일이 있었다(재현됨).
ipcMain.handle("chat:get_permissions", () => skipPermissions);
ipcMain.handle("chat:set_permissions", (_event, allow: boolean) => {
    skipPermissions = allow;
});

// 현재 턴과 백그라운드 작업을 모두 멈춘다. 렌더러는 이 호출과 동시에 턴을 스스로 닫으므로
// 여기서는 chat:done을 보내지 않는다 — 늦게 도착한 done이 다음 턴을 끝내 버릴 수 있다.
ipcMain.handle("chat:stop", () => {
    stopEpoch++;
    // 첫 메시지 재생성이 새 세션을 만들기 전에 멈췄으면 원래 대화로 되돌린다
    restoreReplaceFirst();
    const s = live;
    if (!s) return;
    // 이 순간부터 이 세션의 메시지는 렌더러로 가지 않는다(pump가 버린다)
    s.stopped = true;
    s.turnActive = false;
    s.turnUuid = null;
    s.turnResolve?.();
    s.turnResolve = null;
    settlePendingPermissions(s.sender, "사용자가 중지했습니다");
    endInput(s);
    // 프로세스 정리는 기다리지 않는다. interrupt로 트랜스크립트를 정리할 기회를 잠깐 주고 강제 종료.
    void (async () => {
        try {
            await withTimeout(s.q.interrupt(), 1000);
        } catch {
            // 무시 — 아래에서 강제 종료
        }
        s.q.close();
    })();
});

// 상단 "백그라운드 N" 패널: 셸 작업의 최근 출력. 렌더러는 작업 id만 넘기고, 경로는 CLI가 알려준 것만 쓴다.
ipcMain.handle("background:output", (_event, taskId: string) => {
    const file = live?.outputFiles.get(taskId) ?? finishedOutputFiles.get(taskId);
    return file ? readOutputTail(file) : null;
});

// ── 작업 파일 패널 ──
ipcMain.handle("files:get_changed", () => changedFileList());
ipcMain.handle("files:changes", (_event, p: string) => changedFiles.get(p)?.hunks ?? []);
ipcMain.handle("files:list_dir", (_event, dir: string) => listDir(dir));
ipcMain.handle("files:read", (_event, p: string) => readFileForView(p));
ipcMain.handle("files:reveal", (_event, p: string) => {
    if (canViewPath(p) && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ── 작업 파일 패널의 "Git 변경" 보기 ──
// 마지막 결과를 들고 있다가, 차이를 요청받으면 그 목록에 있는 파일인지 확인한다 — 렌더러가 보낸 경로로
// 아무 파일이나 git에 넘기지 않게. 같은 폴더의 요청이 겹치면 진행 중인 것을 같이 쓴다.
let lastGit: {cwd: string; root: string; initial: boolean; byPath: Map<string, GitChange>} | null = null;
let gitInFlight: {cwd: string; promise: Promise<GitStatusResult>} | null = null;

function refreshGitStatus(): Promise<GitStatusResult> {
    const cwd = currentCwd;
    if (gitInFlight && gitInFlight.cwd === cwd) return gitInFlight.promise;
    const promise: Promise<GitStatusResult> = getGitStatus(cwd, toCwdPath)
        .catch((e): GitStatusResult => ({ok: false, reason: "error", message: (e as Error).message}))
        .then((res) => {
            if (cwd === currentCwd) {
                lastGit = res.ok
                    ? {cwd, root: res.root, initial: res.branch.initial, byPath: new Map(res.files.map((f) => [f.path, f]))}
                    : null;
            }
            return res;
        })
        .finally(() => {
            if (gitInFlight?.promise === promise) gitInFlight = null;
        });
    gitInFlight = {cwd, promise};
    return promise;
}

ipcMain.handle("git:status", () => refreshGitStatus());
ipcMain.handle("git:diff", async (_event, p: unknown) => {
    if (typeof p !== "string") return {error: "잘못된 경로입니다"};
    const lookup = () => (lastGit && lastGit.cwd === currentCwd ? lastGit.byPath.get(p) : undefined);
    let entry = lookup();
    // 목록이 그사이 바뀌었을 수 있다 — 한 번 새로 읽어 본다
    if (!entry) {
        await refreshGitStatus();
        entry = lookup();
    }
    if (!entry || !lastGit) return {error: "Git 변경 목록에 없는 파일입니다"};
    return getGitDiff(lastGit.root, entry, lastGit.initial);
});

// "최근 끝난 작업" 기록 지우기
ipcMain.handle("background:clear_finished", (event) => {
    finishedTasks = [];
    finishedOutputFiles.clear();
    const s = live;
    if (s) sendBackground(s);
    else event.sender.send("chat:background", {running: [], finished: []});
});

// 백그라운드 작업 하나만 멈춘다
ipcMain.handle("background:stop", async (_event, taskId: string) => {
    const s = live;
    if (!s) return;
    try {
        await withTimeout(s.q.stopTask(taskId), 5000);
    } catch (e) {
        console.error("[background] 작업 중지 실패", e);
    }
});

ipcMain.handle("chat:question_response", (_event, id: string, answers: string[][]) => {
    const settle = pendingPermissions.get(id);
    if (!settle) return;
    pendingPermissions.delete(id);
    const questions = pendingQuestions.get(id) ?? [];
    pendingQuestions.delete(id);
    // 답을 되돌릴 자리가 프로토콜상 deny의 message뿐이다. 실측 결과 이 문자열이
    // 그대로 tool_result가 되고 모델이 정상적으로 이어받는다.
    settle({behavior: "deny", message: formatQuestionAnswers(questions, answers)});
});

ipcMain.handle("chat:permission_response", (_event, id: string, allow: boolean, always = false) => {
    const settle = pendingPermissions.get(id);
    if (!settle) return;
    pendingPermissions.delete(id);
    const updates = pendingSuggestions.get(id) ?? [];
    pendingSuggestions.delete(id);
    if (!allow) {
        settle({behavior: "deny", message: "사용자가 거부했습니다"});
        return;
    }
    if (always && updates.length > 0) {
        // 지금 프로세스에는 updatedPermissions로, 다음 프로세스에는 allowedTools로 전달된다
        rememberSessionUpdates(updates);
        settle({behavior: "allow", updatedPermissions: updates});
        return;
    }
    settle({behavior: "allow"});
});

ipcMain.handle("chat:new", (event) => {
    closeLive();
    replaceFirst = null;
    clearFinishedTasks(event.sender);
    resetChangedFiles();
    sendChangedFiles(event.sender);
    unsavedGrants = emptyGrants();
    sessionId = null;
    skipPermissions = true; // 새 대화는 전체 허용으로 시작 — 렌더러가 chat:get_permissions로 다시 읽는다
    lastUserMessage = "";
});

ipcMain.handle("chat:get_cwd", () => currentCwd);
ipcMain.handle("chat:get_model", () => currentModel);
ipcMain.handle("chat:set_model", (_event, model: string) => {
    currentModel = model;
    settings.save({model});
});
ipcMain.handle("chat:get_effort", () => currentEffort);
ipcMain.handle("chat:set_effort", (_event, effort: string) => {
    currentEffort = effort;
    settings.save({effort});
});

ipcMain.handle("chat:get_ultracode", () => ultracode);
ipcMain.handle("chat:set_ultracode", (_event, on: boolean) => {
    ultracode = on;
    settings.save({ultracode: on});
});

ipcMain.handle("chat:get_fast_mode", () => fastMode);
ipcMain.handle("chat:set_fast_mode", (_event, on: boolean) => {
    fastMode = on;
    settings.save({fastMode: on});
});

ipcMain.handle("models:list", () => loadModels());

ipcMain.handle("chat:get_session_id", () => sessionId);

ipcMain.handle("chat:get_rate_limits", () => rateLimitList());

// 이 사용자 메시지를 보내기 직전 상태로 Claude가 고친 파일을 되돌린다. 대화 내용은 그대로다.
// 백업은 세션 기록에 남아 있어 프로세스가 끝난 뒤에도 되돌릴 수 있다(실측).
ipcMain.handle("chat:rewind_files", async (_event, uuid: string, dryRun: boolean): Promise<RewindFilesResult> => {
    if (live?.turnActive) return {canRewind: false, error: "응답이 끝난 뒤에 되돌릴 수 있습니다"};
    if (!sessionId) return {canRewind: false, error: "세션 정보가 없습니다"};
    const s = live && !live.inputEnded ? live : null;
    if (s) return s.q.rewindFiles(uuid, {dryRun});

    const claudePath = resolveClaudePath();
    if (!claudePath) return {canRewind: false, error: "Claude CLI를 찾을 수 없습니다"};
    // 살아 있는 프로세스가 없으면 세션을 재개만 하고(턴은 시작하지 않는다) 되돌린 뒤 닫는다
    const idle = await openIdleQuery({
        pathToClaudeCodeExecutable: claudePath,
        cwd: currentCwd,
        resume: sessionId,
        enableFileCheckpointing: true,
    });
    try {
        return await withTimeout(idle.q.rewindFiles(uuid, {dryRun}), 20000);
    } catch (e) {
        return {canRewind: false, error: (e as Error).message};
    } finally {
        idle.close();
    }
});

// 저장된 세션 이어가기. 세션의 작업 폴더로 옮긴다.
// 폴더가 지워졌으면 옮길 수 없는데, CLI는 어느 폴더에서든 세션을 찾아 이어 주므로 에러 없이
// 지금 폴더에서 대화가 계속된다(실측). 렌더러가 경고할 수 있게 그 사실을 함께 돌려준다.
ipcMain.handle("chat:resume_session", (event, sid: string, cwd?: string) => {
    closeLive();
    replaceFirst = null;
    clearFinishedTasks(event.sender);
    // 허용 규칙은 세션 ID별로 남아 있어서 이 대화로 돌아오면 다시 적용된다
    sessionId = sid;
    const cwdMissing = !!cwd && !fs.existsSync(cwd);
    if (cwd && !cwdMissing && cwd !== currentCwd) {
        currentCwd = cwd;
        pushFolderInfo(event.sender);
    }
    // 작업 파일 패널: 이 대화에서 고친 파일을 세션 기록에서 다시 계산
    resetChangedFiles();
    sendChangedFiles(event.sender);
    void loadChangedFilesFromSession(sid).then((ok) => {
        if (ok) sendChangedFiles(event.sender);
    });
    return {cwd: currentCwd, cwdMissing};
});

// ── 세션 기록 (CLI가 저장한 것 — 터미널에서 한 대화 포함) ──
ipcMain.handle("sessions:list", async () => {
    try {
        const {listSessions} = await loadSdk();
        const list = await listSessions({limit: 100});
        return list.map((s) => ({
            sessionId: s.sessionId,
            title: (s.customTitle || s.summary || s.firstPrompt || "제목 없음").trim(),
            cwd: s.cwd ?? "",
            // 작업 폴더가 지워진 세션 — 열면 다른 폴더에서 이어지므로 목록에서 미리 표시한다
            cwdMissing: !!s.cwd && !fs.existsSync(s.cwd),
            lastModified: s.lastModified,
            gitBranch: s.gitBranch,
        }));
    } catch (e) {
        console.error("[sessions] 목록 조회 실패", e);
        return [];
    }
});

ipcMain.handle("sessions:messages", async (_event, sid: string, cwd?: string) => {
    const {getSessionMessages} = await loadSdk();
    return sessionToMessages(await getSessionMessages(sid, {dir: cwd || undefined}));
});

ipcMain.handle("sessions:delete", async (_event, sid: string, cwd?: string) => {
    grantsBySession.delete(sid);
    if (sid === sessionId) {
        closeLive();
        sessionId = null;
    }
    const {deleteSession} = await loadSdk();
    await deleteSession(sid, {dir: cwd || undefined});
});

ipcMain.handle("prompts:get", () => systemPrompts);
ipcMain.handle("prompts:add", (_event, prompt: string) => {
    systemPrompts = [...systemPrompts, prompt];
    settings.save({systemPrompts});
    return systemPrompts;
});
ipcMain.handle("prompts:remove", (_event, index: number) => {
    systemPrompts = systemPrompts.filter((_, i) => i !== index);
    settings.save({systemPrompts});
    return systemPrompts;
});

ipcMain.handle("commands:list", () => loadCommands());

ipcMain.handle("mcp:status", (_event, refresh?: boolean) => loadMcpStatus(refresh === true));

ipcMain.handle("files:search", (_event, query: string) => searchFilesInCwd(query ?? ""));

ipcMain.handle("dialog:select_directory", async (event) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        defaultPath: currentCwd,
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    closeLive();
    replaceFirst = null;
    clearFinishedTasks(event.sender);
    resetChangedFiles();
    unsavedGrants = emptyGrants();
    currentCwd = result.filePaths[0];
    sendChangedFiles(event.sender);
    pushFolderInfo(event.sender);
    sessionId = null;
    skipPermissions = true; // 폴더를 바꾸면 새 대화 — 전체 허용으로 시작
    lastUserMessage = "";
    return currentCwd;
});

ipcMain.handle("claude:get_status", () => {
    const p = resolveClaudePath();
    return {found: p !== null, path: p};
});

ipcMain.handle("claude:locate", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return {ok: false, error: "창을 찾을 수 없습니다"};

    const result = await dialog.showOpenDialog(win, {
        title: "Claude CLI 실행 파일 선택",
        properties: ["openFile"],
        message: "Claude CLI 실행 파일을 선택하세요 (예: /opt/homebrew/bin/claude)",
        buttonLabel: "선택",
    });
    if (result.canceled || result.filePaths.length === 0) {
        return {ok: false, cancelled: true};
    }

    const picked = result.filePaths[0];
    const verdict = await validateClaudeBinary(picked);
    if (!verdict.ok) {
        return {ok: false, error: verdict.error ?? "검증 실패"};
    }

    settings.setClaudePath(picked);
    resetClaudePathCache();
    return {ok: true, path: picked};
});

ipcMain.handle("claude:open_install_guide", async () => {
    await shell.openExternal("https://docs.claude.com/en/docs/claude-code/setup");
});

// 복사 버튼들 — 렌더러의 navigator.clipboard는 창(문서)에 포커스가 없으면 실패한다
// (개발자 도구에 포커스가 있을 때 등). main의 clipboard는 포커스와 상관없다.
ipcMain.handle("clipboard:write", (_event, text: unknown) => {
    if (typeof text !== "string") return false;
    clipboard.writeText(text);
    return true;
});

// ── macOS 알림 ──
// 언제 띄울지(앱을 보고 있지 않을 때, 설정이 켜져 있을 때)는 렌더러가 정한다. 여기서는 보여 주기만 한다.
// 알림 객체를 들고 있지 않으면 가비지 컬렉션되어 눌러도 반응이 없다(Electron의 알려진 동작).
const shownNotifications = new Set<Notification>();

ipcMain.handle("notify:show", (event, n: {title?: unknown; body?: unknown}) => {
    if (!Notification.isSupported()) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    const note = new Notification({
        title: String(n?.title ?? "Better Claude").slice(0, 100),
        body: String(n?.body ?? "").slice(0, 240),
        // 소리는 앱이 직접 낸다 — 앱의 음량 설정을 따르게
        silent: true,
    });
    shownNotifications.add(note);
    note.on("close", () => shownNotifications.delete(note));
    note.on("click", () => {
        shownNotifications.delete(note);
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
        app.focus({steal: true});
    });
    note.show();
    return true;
});

// 앱으로 돌아오면 쌓인 알림을 거둔다 — 이미 화면에서 보고 있는 내용이다
app.on("browser-window-focus", () => {
    for (const note of shownNotifications) note.close();
    shownNotifications.clear();
});

app.whenReady().then(() => {
    loadChatSettings();
    const claudePath = resolveClaudePath();
    if (claudePath) {
        console.log(`[bootstrap] Claude CLI 감지: ${claudePath}`);
    } else {
        console.error(
            "[bootstrap] Claude CLI를 찾을 수 없습니다. " +
                "PATH에 추가하거나 CLAUDE_PATH 환경변수로 경로를 지정하세요."
        );
    }

    createMainWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
