import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createMainWindow } from "./main/windows/create-main-window";
import * as api from "./main/services/api-client";
import {resetCache as resetClaudePathCache, resolveClaudePath, validateClaudeBinary} from "./main/services/claude-path";
import * as settings from "./main/services/settings";
import {expandPathForChildProcesses} from "./main/services/path-expander";
import {loadSdk} from "./main/services/claude-sdk";
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

// 이 대화에서 항상 허용한 규칙들. CLI의 세션 규칙은 프로세스가 끝나면 사라지는데
// 앱은 턴마다 프로세스를 새로 띄우므로, 여기 모아 두었다가 매번 옵션으로 다시 넘긴다.
// 새 대화/다른 대화 불러오기/작업 디렉토리 변경 시 비운다.
let sessionAllowedTools: string[] = [];
let sessionDirectories: string[] = [];
// Write/Edit 권한에 CLI가 제안하는 "파일 편집 자동 허용"(acceptEdits 모드)
let sessionAcceptEdits = false;

function resetSessionPermissions() {
    sessionAllowedTools = [];
    sessionDirectories = [];
    sessionAcceptEdits = false;
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
    for (const u of updates) {
        if (u.type === "addRules") {
            for (const r of u.rules) {
                const rule = formatRule(r);
                if (!sessionAllowedTools.includes(rule)) sessionAllowedTools.push(rule);
            }
        } else if (u.type === "addDirectories") {
            for (const d of u.directories) {
                if (!sessionDirectories.includes(d)) sessionDirectories.push(d);
            }
        } else if (u.type === "setMode" && u.mode === "acceptEdits") {
            sessionAcceptEdits = true;
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
    return new Promise((settle) => {
        const id = `perm-${++permissionSeq}`;
        pendingPermissions.set(id, settle);

        // AskUserQuestion은 권한이 아니라 질문이다. CLI는 이 도구를 스스로 실행해
        // 터미널에 선택지를 그리는데, 헤드리스에서는 그릴 곳이 없어
        // "The user did not answer the questions."로 끝난다.
        // 그래서 앱이 직접 물어보고, 답을 tool_result 자리에 실어 보낸다.
        const questions = toolName === "AskUserQuestion" ? parseQuestions(input) : null;
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
    idleTimer: ReturnType<typeof setTimeout> | null;
    errorSent: boolean;
    stderrTail: string;
    stopped: boolean;
    ended: Promise<void>;
}

let live: LiveSession | null = null;

// 중지 버튼이 눌린 횟수. sendTurn이 CLI를 띄우는 도중(await 사이)에 중지되면
// 이 값이 바뀐 걸 보고 턴을 시작하지 않는다.
let stopEpoch = 0;

// 백그라운드 작업이 모두 끝났는데 후속 턴이 시작되지 않으면 이 시간 뒤 프로세스를 정리한다
const IDLE_END_MS = 60_000;

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

async function startLive(sender: Electron.WebContents, claudePath: string): Promise<LiveSession> {
    const {query} = await loadSdk();
    const input = createInputQueue();
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
            permissionMode: skipPermissions ? "bypassPermissions" : sessionAcceptEdits ? "acceptEdits" : "default",
            allowedTools: sessionAllowedTools.length > 0 ? [...sessionAllowedTools] : undefined,
            additionalDirectories: sessionDirectories.length > 0 ? [...sessionDirectories] : undefined,
            // 글자 단위 스트리밍(stream_event). 완성된 assistant 메시지도 따로 온다 — handleSdkMessage 참고
            includePartialMessages: true,
            // 메시지 시점으로 파일을 되돌릴 수 있게 수정 전 백업을 남긴다(rewindFiles)
            enableFileCheckpointing: true,
            canUseTool: skipPermissions
                ? undefined
                : (toolName, toolInput, opts) =>
                      askPermission(s.sender, toolName, toolInput as Record<string, unknown>, opts),
            systemPrompt:
                systemPrompts.length > 0
                    ? {type: "preset", preset: "claude_code", append: systemPrompts.join("\n\n")}
                    : undefined,
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

            // 백그라운드 작업 완료 알림으로 CLI가 스스로 시작한 턴
            if (!s.turnActive && msg.type === "assistant") {
                beginTurn(s, null, null);
                s.sender.send("chat:turn_start");
            }

            if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
                const tasks = (msg as unknown as {
                    tasks: {task_id: string; task_type: string; description: string; ambient?: boolean}[];
                }).tasks ?? [];
                s.backgroundTasks = tasks.length;
                s.sender.send(
                    "chat:background",
                    tasks
                        .filter((t) => !t.ambient)
                        .map((t) => ({id: t.task_id, type: t.task_type, description: t.description}))
                );
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
        s.sender.send("chat:background", []);
        if (live === s) live = null;
    }
}

async function sendTurn(sender: Electron.WebContents, message: string, images: ImageData[]): Promise<void> {
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
    if (prev && (prev.inputEnded || prev.key !== optionsKey())) {
        if (!prev.inputEnded) closeLive();
        await prev.ended;
    }

    const content: object[] = [{type: "text", text: message}];
    for (const img of images) {
        content.push({
            type: "image",
            source: {type: "base64", media_type: img.mediaType, data: img.data},
        });
    }

    // 렌더러는 중지 즉시 턴을 닫았다. 여기서 시작하면 아무도 안 듣는 턴이 돈다.
    if (epoch !== stopEpoch) return;

    let s: LiveSession;
    try {
        s = live ?? (await startLive(sender, claudePath));
        if (epoch !== stopEpoch) {
            closeLive();
            return;
        }
    } catch (e) {
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
    if (sid && !sessionId) sessionId = sid;

    // 글자 단위 스트리밍. 이 메시지 id를 기억해 두고, 뒤따라오는 완성본에서는
    // 텍스트/사고 블록을 다시 보내지 않는다(중복 방지). 도구 호출은 완성본에서 보낸다.
    if (msg.type === "stream_event") {
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
                if (!streamed) sender.send("chat:chunk", block.text);
            } else if (block.type === "thinking" && block.thinking) {
                if (!streamed) sender.send("chat:thinking", block.thinking);
            } else if (block.type === "tool_use" && block.id && block.name) {
                sender.send("chat:tool_use", {
                    id: block.id,
                    name: block.name,
                    input: block.input ?? {},
                });
            }
        }
        const usage = msg.message?.usage;
        if (usage) {
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

ipcMain.handle("chat:send", (event, message: string, images: ImageData[] = []) => {
    lastUserMessage = message;
    return sendTurn(event.sender, message, images);
});

ipcMain.handle("chat:set_permissions", (_event, allow: boolean) => {
    skipPermissions = allow;
});

// 현재 턴과 백그라운드 작업을 모두 멈춘다. 렌더러는 이 호출과 동시에 턴을 스스로 닫으므로
// 여기서는 chat:done을 보내지 않는다 — 늦게 도착한 done이 다음 턴을 끝내 버릴 수 있다.
ipcMain.handle("chat:stop", () => {
    stopEpoch++;
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

ipcMain.handle("chat:new", () => {
    closeLive();
    resetSessionPermissions();
    sessionId = null;
    skipPermissions = true;
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

// 저장된 세션 이어가기. 세션 기록은 프로젝트 폴더별로 저장되므로 그 폴더로 옮겨야 재개된다.
ipcMain.handle("chat:resume_session", (event, sid: string, cwd?: string) => {
    closeLive();
    resetSessionPermissions();
    sessionId = sid;
    if (cwd && cwd !== currentCwd && fs.existsSync(cwd)) {
        currentCwd = cwd;
        pushFolderInfo(event.sender);
    }
    return currentCwd;
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
    resetSessionPermissions();
    currentCwd = result.filePaths[0];
    pushFolderInfo(event.sender);
    sessionId = null;
    skipPermissions = true;
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
