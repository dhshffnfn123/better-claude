import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, Notification, shell } from "electron";
import { createMainWindow, windowBackground } from "./main/windows/create-main-window";
import { installAppMenu } from "./main/menu";
import {resetCache as resetClaudePathCache, resolveClaudePath, validateClaudeBinary} from "./main/services/claude-path";
import * as settings from "./main/services/settings";
import {readJsonFile, writeJsonFile} from "./main/services/json-store";
import {expandPathForChildProcesses} from "./main/services/path-expander";
import {loadSdk} from "./main/services/claude-sdk";
import {getGitDiff, getGitStatus, isGitIgnored} from "./main/services/git-changes";
import * as instr from "./main/services/instructions";
import * as plug from "./main/services/plugins";
import {installPreviewProtocol, MAX_PREVIEW_HTML, PREVIEW_SCHEME, registerDir, registerHtml, registerPreviewScheme} from "./main/services/previews";
import {imageDataUrl, imageFile, imageThumbnail, sniffImage, toolResultImages} from "./main/services/images";
import {openInIde, pickIde} from "./main/services/jetbrains";
import {explainMcpLoginError, isOpenableAuthUrl, TERMINAL_LOGIN_HINT} from "./main/services/mcp-login";
import type {McpAuthMethods, McpAuthReply, McpLoginError} from "./main/services/mcp-login";
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
// HTML 미리보기 주소(bc-preview://) — app ready 전에 등록해야 한다
registerPreviewScheme();
import os from "os";
import fs from "fs";
import path from "path";
import readline from "readline";
import {randomUUID} from "crypto";

// 채팅 설정은 탭마다 따로 있다(ChatTab). 이건 렌더러가 설정을 넘기지 않고 연 탭(첫 탭 등)이 받는 기본값으로,
// 탭에서 설정을 바꿀 때마다 그 값으로 바뀌고 settings.json에 저장된다(loadChatSettings가 앱 시작 때 읽는다).
const defaults = {model: "claude-opus-5-5", effort: "xhigh", ultracode: false, fastMode: false};
let systemPrompts: string[] = [];
// 다음 요청 추천 (설정에서 끌 수 있다) — 새로 띄우는 CLI부터 적용된다
let promptSuggestionsOn = true;

function loadChatSettings() {
    const saved = settings.load();
    if (typeof saved.model === "string" && saved.model) defaults.model = saved.model;
    if (typeof saved.effort === "string" && saved.effort) defaults.effort = saved.effort;
    if (typeof saved.ultracode === "boolean") defaults.ultracode = saved.ultracode;
    if (typeof saved.fastMode === "boolean") defaults.fastMode = saved.fastMode;
    if (Array.isArray(saved.systemPrompts)) {
        systemPrompts = saved.systemPrompts.filter((p): p is string => typeof p === "string");
    }
    nativeTheme.themeSource = isThemeSource(saved.theme) ? saved.theme : "system";
    if (typeof saved.promptSuggestions === "boolean") promptSuggestionsOn = saved.promptSuggestions;
}

type ThemeSource = "system" | "light" | "dark";

// ── 탭 ─────────────────────────────────────────────────────────────────────────
// 탭 하나 = 대화 하나. 세션·작업 폴더·채팅 설정·권한 모드·CLI 프로세스·파일 패널과 백그라운드 기록을 탭마다 따로 둔다.
// 탭 id는 렌더러가 정해서(tabs:open) 모든 요청에 싣고, main이 보내는 이벤트에는 첫 인자로 탭 id를 붙인다(send).
// 응답 중인 탭마다 CLI 프로세스가 하나씩 돈다. 쉬는 탭은 프로세스가 없다(응답이 끝나면 닫는다 — LiveSession 참고).
// 첫 메시지 재생성·편집으로 버리는 옛 세션 (ChatTab.replaceFirst)
interface ReplaceFirst {
    oldSid: string;
    // 교체를 시작할 때 옛 세션의 마지막 기록. 지우기 전에 다시 보고, 달라졌으면(그사이 다른 탭·터미널에서 이어 썼으면) 남긴다.
    lastUuid: string;
    newSid?: string;
    // 실패한 재생성 뒤 새 세션의 첫 메시지를 또 바꿨다 — 그 앞의 교체. 성공하면 원래 대화까지 함께 지운다.
    prev?: ReplaceFirst;
}

interface ChatTab {
    id: string;
    sender: Electron.WebContents;
    cwd: string;
    sessionId: string | null;
    model: string;
    effort: string;
    ultracode: boolean;
    fastMode: boolean;
    // 방패: 기본 "전체 허용", "확인 모드"는 이 대화에서만 쓰는 임시 모드
    skipPermissions: boolean;
    // 세션 ID가 아직 없는 새 대화에서 "항상 허용"한 것 — ID가 정해지면 grantsBySession으로 옮긴다
    unsavedGrants: SessionGrants;
    live: LiveSession | null;
    // 진행 중인 chat:send 수 — CLI를 띄우는 동안(live가 아직 없음)도 "응답 중"으로 세려고 (창 닫기·종료 확인)
    sending: number;
    // 중지 버튼이 눌린 횟수. sendTurn이 CLI를 띄우는 도중(await 사이)에 중지되면 이 값이 바뀐 걸 보고 턴을 시작하지 않는다.
    stopEpoch: number;
    // 첫 메시지를 재생성·편집하면 앞에 이어갈 지점이 없어 새 세션으로 시작한다.
    // 옛 세션은 새 세션의 답이 성공했을 때 지운다(commitReplaceFirst). 새 세션이 생기지 못하고 끝나면 되돌린다.
    // newSid = 새 세션이 생겼다 — 그 답이 실패해도(한도·오프라인) 옛 대화는 지우지 않고 남긴다.
    replaceFirst: ReplaceFirst | null;
    // 스트리밍으로 이미 렌더러에 보낸 assistant 메시지 id. 턴마다 비운다.
    streamedMessageIds: Set<string>;
    // 작업 파일 패널: Claude가 이 대화에서 고친 파일
    changedFiles: Map<string, ChangedFileInfo>;
    // 결과가 오기 전의 수정 시도 (tool_use id → 내용). 성공 결과가 오면 changedFiles에 반영한다.
    pendingEdits: Map<string, PendingEdit>;
    fileTurn: number;
    // 비울 때마다 올린다 — 세션 기록을 읽는 동안 다른 대화로 옮겼으면 그 결과를 버리기 위해
    changedFilesGen: number;
    // "Claude 수정" 내역을 지운 시각(0 = 안 지움) — 이 시각 이후에 끝난 수정만 센다
    changesClearedAt: number;
    // 이 대화에서 최근에 끝난 백그라운드 작업 (최신순). CLI 프로세스가 끝나도 남는다.
    finishedTasks: FinishedTask[];
    // 끝난 셸 작업의 출력 파일 (작업 id → 경로) — 끝난 뒤에도 출력을 보여주려고
    finishedOutputFiles: Map<string, string>;
    // "Git 변경" 보기의 마지막 결과와 진행 중인 요청
    lastGit: {cwd: string; root: string; initial: boolean; byPath: Map<string, GitChange>} | null;
    gitInFlight: {cwd: string; promise: Promise<GitStatusResult>} | null;
    // 답변 속 그림으로 확인해 준 파일 (images:resolve) — 원본 보기(images:read)는 이것과 작업 파일 패널 범위만 읽는다
    imagePaths: Set<string>;
    // 끝난 작업의 상태 (task_notification) — 백그라운드가 아닌 것도. "에이전트가 한 일" 패널의 완료/실패 표시용
    // (finishedTasks는 백그라운드로 돈 작업만 남긴다). 대화를 바꾸면 비운다.
    taskStatuses: Map<string, FinishedTask["status"]>;
    // 지침 패널이 읽고 고칠 수 있는 파일 — 마지막 instructions:list 결과(지침 파일, 대화 중 불려 온 지침, 만들 수 있는 자리)와
    // 기억 폴더의 .md 파일. 렌더러가 넘긴 아무 경로나 쓰지 않으려고 둔다. readOnly = 관리 지침(회사 정책 파일).
    instructionPaths: Set<string>;
    instructionReadOnly: Set<string>;
    memoryDir: string | null;
}

const tabs = new Map<string, ChatTab>();

function createTab(id: string, sender: Electron.WebContents): ChatTab {
    return {
        id,
        sender,
        cwd: os.homedir(),
        sessionId: null,
        ...defaults,
        skipPermissions: true,
        unsavedGrants: emptyGrants(),
        live: null,
        sending: 0,
        stopEpoch: 0,
        replaceFirst: null,
        streamedMessageIds: new Set(),
        changedFiles: new Map(),
        pendingEdits: new Map(),
        fileTurn: 0,
        changedFilesGen: 0,
        changesClearedAt: 0,
        finishedTasks: [],
        finishedOutputFiles: new Map(),
        lastGit: null,
        gitInFlight: null,
        imagePaths: new Set(),
        taskStatuses: new Map(),
        instructionPaths: new Set(),
        instructionReadOnly: new Set(),
        memoryDir: null,
    };
}

// 요청을 보낸 탭. 렌더러가 tabs:open 전에 보낸 요청이어도 탭을 만들어 받는다(기본 설정·홈 폴더).
function tabFor(event: Electron.IpcMainInvokeEvent, id: unknown): ChatTab {
    const key = typeof id === "string" && id ? id : "default";
    let tab = tabs.get(key);
    if (!tab) {
        tab = createTab(key, event.sender);
        tabs.set(key, tab);
    }
    tab.sender = event.sender;
    return tab;
}

// 탭의 이벤트를 렌더러로 — 첫 인자가 탭 id다.
// 없앤 탭(닫음·창 닫음·화면 새로 시작)의 늦은 이벤트는 버린다 — 정리된 CLI의 마지막 chat:done이
// 같은 id로 다시 연 탭(새로고침 뒤 복원)에 들어가 새 턴을 끝내 버리지 않게.
function send(tab: ChatTab, channel: string, payload?: unknown) {
    if (tabs.get(tab.id) !== tab) return;
    if (!tab.sender.isDestroyed()) tab.sender.send(channel, tab.id, payload);
}

function isThemeSource(v: unknown): v is ThemeSource {
    return v === "system" || v === "light" || v === "dark";
}

// ultracode는 xhigh 고정 모드라(CLI의 /effort 메뉴 설명 그대로 "xhigh + dynamic
// workflow orchestration"), 켜져 있으면 드롭다운 값 대신 xhigh를 쓴다.
function effectiveEffort(tab: ChatTab): string {
    return tab.ultracode ? "xhigh" : tab.effort;
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

async function loadModels(cwd: string = os.homedir()): Promise<ModelInfo[] | null> {
    if (modelCache) return modelCache;
    const init = await probeFolder(cwd).init;
    if (init?.models?.length) modelCache = init.models;
    return modelCache;
}

// ── 지침 패널: 이 폴더에서 Claude가 대화를 시작할 때 읽는 지침 파일 ──
// CLI에게 묻는다 — 턴을 시작하지 않는 query의 getContextUsage().memoryFiles = {path, type, tokens}. 실측: 작업 폴더부터
// 위로 올라가며 찾은 CLAUDE.md, 그 안의 @import, paths 없는 .claude/rules, CLAUDE.local.md(Local), 사용자 공통(User),
// 자동 메모리 목록 MEMORY.md(AutoMem). "full"은 토큰 세기 API로 정확히 센다(0.5초 남짓, 대화 비용 없음).
// 폴더·모델마다 캐시하고, 앱에서 저장했거나 Claude가 지침 파일을 고치면 비운다(invalidateInstructions).
interface InstructionMeasure {
    files: {path: string; type: string; tokens: number}[];
    startTotal: number; // 새 대화를 시작하면 바로 쓰는 컨텍스트 (시스템 프롬프트·도구·지침)
    maxTokens: number;
    at: number;
}

const instructionCache = new Map<string, Promise<InstructionMeasure | null>>();

function measureInstructions(tab: ChatTab, refresh = false): Promise<InstructionMeasure | null> {
    // 시스템 프롬프트도 키에 넣는다 — 새 대화 시작 컨텍스트(startTotal)에 들어가서, 바꾸면 다시 세야 한다
    const key = `${tab.cwd}\u0000${tab.model}\u0000${systemPrompts.join("\u0001")}`;
    const cached = instructionCache.get(key);
    if (cached && !refresh) return cached;
    const claudePath = resolveClaudePath();
    if (!claudePath) return Promise.resolve(null);
    const {cwd, model} = tab;
    const p = (async (): Promise<InstructionMeasure | null> => {
        const idle = await openIdleQuery({
            pathToClaudeCodeExecutable: claudePath,
            cwd,
            model,
            // 실제 대화와 같은 시스템 프롬프트 — "새 대화 시작 컨텍스트"를 대화와 같게 세려고
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined,
                snapshot: false,
            },
        });
        try {
            const usage = await withTimeout(idle.q.getContextUsage({detail: "full"}), 15_000).catch(() =>
                withTimeout(idle.q.getContextUsage({detail: "summary"}), 10_000)
            );
            return {
                files: usage.memoryFiles.map((f) => ({path: f.path, type: f.type, tokens: f.tokens})),
                startTotal: usage.totalTokens,
                maxTokens: usage.maxTokens,
                at: Date.now(),
            };
        } finally {
            idle.close();
        }
    })().catch((e) => {
        console.error("[instructions] 지침 파일 확인 실패", e);
        return null;
    });
    instructionCache.set(key, p);
    // 실패는 캐시하지 않는다 — 다음에 다시 묻는다
    void p.then((r) => {
        if (!r && instructionCache.get(key) === p) instructionCache.delete(key);
    });
    return p;
}

// 지침·기억 파일이 바뀌었다(앱에서 저장·삭제, Claude가 Write/Edit로 고침) — 다시 세고 모든 탭에 알린다.
// 사용자 공통 지침은 모든 탭에 들어가고, 같은 저장소를 연 탭도 여럿일 수 있다.
let instructionsNotifyTimer: ReturnType<typeof setTimeout> | null = null;
function invalidateInstructions() {
    instructionCache.clear();
    notifyInstructions();
}

// 패널 목록만 새로 읽게 알린다(다시 세지는 않는다)
function notifyInstructions() {
    if (instructionsNotifyTimer) clearTimeout(instructionsNotifyTimer);
    instructionsNotifyTimer = setTimeout(() => {
        instructionsNotifyTimer = null;
        for (const tab of tabs.values()) send(tab, "chat:instructions", {});
    }, 300);
}

function noteInstructionEdit(p: string) {
    if (!instr.isInstructionLike(p)) return;
    // 기억 파일 하나는 대화 시작 때 읽는 파일이 아니다 — CLI를 다시 띄워 셀 필요 없이 목록만 새로 (목록 MEMORY.md는 다시 센다)
    if (instr.isMemoryTopicFile(p)) notifyInstructions();
    else invalidateInstructions();
}

// ── 기억 알림 ("클로드는 이것을 기억할 것입니다") ──
// Claude가 자동 메모리에 기억 하나를 저장했다(Write·Edit·MultiEdit 성공) → chat:memory_saved로 그 탭에 알린다.
// 실시간 수정만 온다(trackFileEdits의 onEdited — 저장된 대화를 열 때 다시 계산하는 것은 부르지 않는다). 서브에이전트가 쓴 것도.
// 기억 파일 하나만 — 목록 MEMORY.md만 고친 건 알리지 않는다(기억 하나를 쓰면 Claude가 목록 줄도 고친다).
// 무엇을 기억했는지 = frontmatter의 description(없으면 name — 화면이 파일 이름까지 대신 쓴다): Write면 쓴 내용, Edit면 고친 뒤의 파일.
// 켜고 끄기는 렌더러(설정 → 기억 알림)가 정한다 — main은 늘 보낸다.
async function noteMemorySaved(tab: ChatTab, p: string, done: EditDone) {
    if (!instr.isMemoryTopicFile(p) || done.staged) return;
    let text = done.tool === "Write" ? done.content : undefined;
    if (text === undefined) {
        try {
            text = (await fs.promises.readFile(p, "utf8")).slice(0, 64 * 1024);
        } catch {
            text = "";
        }
    }
    const {fields} = instr.parseFrontmatter(text);
    send(tab, "chat:memory_saved", {
        path: p,
        name: fields.name || undefined,
        description: fields.description || undefined,
        // 있던 기억을 고쳤다 — Edit·MultiEdit, 또는 이미 있던 파일 위에 Write(결과가 "update")
        updated: done.tool !== "Write" || done.created === false,
    });
}

interface AppSlashCommand {
    name: string;
    description: string;
    argumentHint?: string;
    source: "builtin" | "custom";
    aliases?: string[]; // 같은 명령의 다른 이름 (/cost·/stats → /usage) — 입력창이 친 이름을 알아보는 데 쓴다
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
            aliases: c.aliases?.length ? c.aliases : undefined,
        });
    }
    return [...byName.values()].sort((a, b) => (a.source === b.source ? 0 : a.source === "custom" ? -1 : 1));
}

interface AppMcpServer {
    name: string;
    status: McpServerStatus["status"];
    error?: string;
    scope?: string;
    // 연결 방식: http | sse | stdio | claudeai-proxy(claude.ai 커넥터) | sdk — 로그인·로그아웃 버튼을 고르는 데 쓴다
    transport: string;
    toolCount: number;
}

function toMcpList(status: McpServerStatus[] | null): AppMcpServer[] {
    return (status ?? []).map((m) => ({
        name: m.name,
        status: m.status,
        error: m.error,
        scope: m.scope,
        transport: m.config?.type ?? "stdio",
        toolCount: m.tools?.length ?? 0,
    }));
}

// refresh: 폴더 정보를 새로 받는다 — 입력창이 목록에 없는 명령을 쳤을 때(터미널에서 방금 설치한 플러그인의 스킬 등).
// 폴더 정보는 폴더마다 한 번만 받아 두어서, 그러지 않으면 앱을 다시 켤 때까지 없는 명령으로 보였다.
async function loadCommands(tab: ChatTab, refresh = false): Promise<AppSlashCommand[]> {
    // 살아 있는 세션이 있으면 그쪽이 최신이다(작업 중 발견된 스킬까지 반영) — 새로 받을 때는 빼고: 그 프로세스는 뜬 뒤에
    // 생긴 파일을 모른다. 새로 띄운 CLI가 지금 폴더의 파일을 읽는다.
    const live = tab.live;
    if (live && !live.inputEnded && !refresh) {
        try {
            return toCommandList(await withTimeout(live.q.supportedCommands(), 5000));
        } catch {
            // 아래 폴더 정보로 대체
        }
    }
    const init = await probeFolder(tab.cwd, refresh).init;
    return toCommandList(init?.commands ?? []);
}

async function loadMcpStatus(tab: ChatTab, refresh = false): Promise<AppMcpServer[]> {
    const live = tab.live;
    if (live && !live.inputEnded && !refresh) {
        try {
            return toMcpList(await withTimeout(live.q.mcpServerStatus(), 5000));
        } catch {
            // 아래 폴더 정보로 대체
        }
    }
    return toMcpList(await probeFolder(tab.cwd, refresh).mcp);
}

// 탭의 작업 폴더가 정해지거나 바뀌면 그 폴더의 명령/MCP 목록을 렌더러에 밀어 준다
function pushFolderInfo(tab: ChatTab) {
    const cwd = tab.cwd;
    void loadCommands(tab).then((list) => {
        if (cwd === tab.cwd) send(tab, "chat:commands", list);
    });
    void loadMcpStatus(tab).then((list) => {
        if (cwd === tab.cwd) send(tab, "chat:mcp", list);
    });
}

// ── MCP 서버 로그인 (OAuth) ──
// "인증 필요"인 서버에 앱에서 바로 로그인한다(MCP 팝업의 [로그인]). 흐름 (CLI 2.1.325 실측):
//   1. 그 탭의 작업 폴더에 로그인 전용 idle query를 띄우고 mcpAuthenticate(이름) — CLI가 OAuth 메타데이터를 찾고 클라이언트를
//      등록한 뒤 인증 주소를 돌려준다. SDK 모드의 CLI는 브라우저를 열지 않는다(skipBrowserOpen: true) → 앱이 연다(한 번만).
//   2. CLI는 127.0.0.1에 콜백 서버를 띄워 브라우저의 리디렉트를 기다린다 — 그래서 이 CLI 프로세스는 끝날 때까지 살아 있어야 한다.
//      받으면 토큰을 저장하고(CLI 설정의 키체인 항목) 그 서버에 다시 연결한다.
//   3. 앱은 그 query의 mcpServerStatus()를 1.5초마다 보고 connected가 되면 성공 — query를 닫고 다른 탭의 살아 있는 세션은
//      그 서버만 다시 연결한다(다른 CLI 프로세스도 다시 연결하면 새 토큰을 읽는다 — 실측).
// 토큰은 폴더와 무관하게 저장되므로 로그인은 서버 이름마다 하나만 돈다(mcpLogins). 상태는 모든 창에 보낸다(mcp:login).
// claude.ai 커넥터는 주소(claude.ai 설정)만 열고 끝낸다 — 연결은 claude.ai에서 하고, 사용자가 [다시 확인]을 누른다.
type McpLoginPhase = "starting" | "waiting" | "claudeai" | "done" | "error" | "cancelled";

interface McpLoginState extends Partial<McpLoginError> {
    name: string;
    phase: McpLoginPhase;
    seq: number; // 바뀔 때마다 오른다 — 렌더러가 늦게 온 옛 상태를 버린다
}

interface McpLogin {
    name: string;
    cwd: string;
    state: McpLoginState;
    started: Promise<McpLoginState>; // mcpAuthenticate의 답까지 (같은 서버를 또 누르면 이걸 같이 기다린다)
    idle: {q: Query; close: () => void} | null;
    closed: boolean;
    deadline: number;
    timer: ReturnType<typeof setTimeout> | null;
    sawUnconnected: boolean; // 로그인 전 상태(인증 필요 등)를 봤다 — 처음부터 연결돼 있던 서버를 성공으로 착각하지 않게
    endedAt: number | null; // CLI의 로그인이 끝났다(콜백을 받았거나 실패) — 이후에도 연결되지 않으면 실패
    statusErrors: number;
}

const mcpLogins = new Map<string, McpLogin>();
let mcpLoginSeq = 0;
// CLI의 콜백 서버도 5분 뒤 "Authentication timeout"으로 끝난다
const MCP_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MCP_LOGIN_POLL_MS = 1500;
// 콜백을 받은 뒤 토큰 교환·다시 연결에 걸리는 시간 (실측 0.6초 남짓, 넉넉히). 브라우저에서 거절하면 이만큼 뒤에 실패로 보인다.
const MCP_LOGIN_END_GRACE_MS = 10_000;

function broadcastMcpLogin(state: McpLoginState) {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("mcp:login", state);
    }
}

function setMcpLoginState(flow: McpLogin, patch: Partial<McpLoginState>): McpLoginState {
    flow.state = {name: flow.name, phase: flow.state.phase, ...patch, seq: ++mcpLoginSeq};
    broadcastMcpLogin(flow.state);
    return flow.state;
}

// 로그인을 끝낸다(성공·실패·취소) — CLI를 닫으면 콜백 서버도 같이 꺼진다(실측: 그 포트가 ECONNREFUSED)
function endMcpLogin(flow: McpLogin, patch: Partial<McpLoginState>): McpLoginState {
    if (flow.closed) return flow.state;
    flow.closed = true;
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = null;
    flow.idle?.close();
    flow.idle = null;
    if (mcpLogins.get(flow.name) === flow) mcpLogins.delete(flow.name);
    return setMcpLoginState(flow, patch);
}

function startMcpLogin(tab: ChatTab, name: string): Promise<McpLoginState> {
    const running = mcpLogins.get(name);
    if (running) return running.state.phase === "starting" ? running.started : Promise.resolve(running.state);
    const claudePath = resolveClaudePath();
    if (!claudePath) {
        const state: McpLoginState = {name, phase: "error", seq: ++mcpLoginSeq, error: "Claude CLI를 찾지 못했습니다"};
        broadcastMcpLogin(state);
        return Promise.resolve(state);
    }
    const state: McpLoginState = {name, phase: "starting", seq: ++mcpLoginSeq};
    const flow: McpLogin = {
        name,
        cwd: tab.cwd,
        state,
        started: Promise.resolve(state),
        idle: null,
        closed: false,
        deadline: Date.now() + MCP_LOGIN_TIMEOUT_MS,
        timer: null,
        sawUnconnected: false,
        endedAt: null,
        statusErrors: 0,
    };
    mcpLogins.set(name, flow);
    broadcastMcpLogin(state);
    flow.started = runMcpLogin(flow, claudePath);
    return flow.started;
}

async function runMcpLogin(flow: McpLogin, claudePath: string): Promise<McpLoginState> {
    try {
        const idle = await openIdleQuery({pathToClaudeCodeExecutable: claudePath, cwd: flow.cwd});
        if (flow.closed) {
            idle.close(); // 띄우는 사이 취소했다
            return flow.state;
        }
        flow.idle = idle;
        await withTimeout(idle.q.initializationResult(), 30_000);
        // 그새 다른 곳(터미널의 /mcp 등)에서 로그인해 이미 연결됐으면 시작하지 않는다 — 로그인을 시작하면 CLI가 그 서버의
        // 저장된 토큰부터 지우므로(OAuth 흐름의 첫 단계), 여기서 취소하면 멀쩡한 로그인이 사라진다
        const before = await settledMcpStatus(idle.q, flow.name);
        if (flow.closed) return flow.state;
        if (before.me?.status === "connected") {
            refreshMcpEverywhere(flow.name, {cwd: flow.cwd, list: before.list});
            return endMcpLogin(flow, {phase: "done"});
        }
        if (before.me) flow.sawUnconnected = true;
        const api = idle.q as unknown as McpAuthMethods;
        if (typeof api.mcpAuthenticate !== "function") {
            return endMcpLogin(flow, {phase: "error", error: TERMINAL_LOGIN_HINT, unavailable: true});
        }
        // 답이 오기 전에 OAuth 메타데이터 조회·클라이언트 등록을 한다 — 서버가 느리면 몇 초 걸린다
        const reply = await withTimeout(api.mcpAuthenticate(flow.name), 60_000);
        if (flow.closed) return flow.state;
        return afterMcpAuthReply(flow, reply ?? {});
    } catch (e) {
        if (flow.closed) return flow.state; // 취소로 CLI가 닫혀 생긴 오류
        return endMcpLogin(flow, {phase: "error", ...explainMcpLoginError((e as Error)?.message ?? String(e))});
    }
}

// 막 띄운 CLI는 서버마다 연결을 시도하는 중(pending)이다 — 그 서버의 결과가 나올 때까지 잠깐 기다린다
async function settledMcpStatus(q: Query, name: string): Promise<{list: McpServerStatus[]; me?: McpServerStatus}> {
    const deadline = Date.now() + 8000;
    for (;;) {
        const list = await withTimeout(q.mcpServerStatus(), 5000);
        const me = list.find((m) => m.name === name);
        if (me?.status !== "pending" || Date.now() > deadline) return {list, me};
        await new Promise((r) => setTimeout(r, 400));
    }
}

function afterMcpAuthReply(flow: McpLogin, reply: McpAuthReply): McpLoginState {
    const url = typeof reply.authUrl === "string" ? reply.authUrl : "";
    if (url) {
        if (!isOpenableAuthUrl(url)) {
            return endMcpLogin(flow, {
                phase: "error",
                error: "https가 아닌 로그인 주소라 열지 않았습니다",
                detail: url.slice(0, 300),
            });
        }
        shell.openExternal(url).catch((e) => console.error("[mcp] 로그인 주소를 열지 못했습니다", e));
    }
    // claude.ai 커넥터 — 기다릴 콜백이 없다. 연결은 claude.ai에서 마치고 사용자가 [다시 확인]을 누른다.
    if (url && reply.callbackExpected === false) return endMcpLogin(flow, {phase: "claudeai"});
    // 브라우저에서 허용하면 CLI가 콜백을 받아 연결한다 — 연결됨이 될 때까지 지켜본다
    // (주소 없이 온 답 = 사용자 확인 없이 토큰을 받았다 — 같은 방법으로 확인한다)
    setMcpLoginState(flow, {phase: "waiting"});
    flow.timer = setTimeout(() => void pollMcpLogin(flow), url ? MCP_LOGIN_POLL_MS : 300);
    return flow.state;
}

// CLI가 아직 콜백을 기다리는지 — 코드도 오류도 없는 주소를 콜백으로 넣어 본다. 기다리는 중이면 "Invalid callback URL: missing
// authorization code"로 거절하고(진행 중인 로그인은 건드리지 않는다 — 콜백 처리기를 부르기 전에 거른다), 끝났으면(콜백을 받았거나
// 실패) "No active OAuth flow for server"라고 답한다(실측). 브라우저에서 거절하면 상태는 계속 "인증 필요"라 이걸로 실패를 안다.
async function mcpLoginEnded(q: Query, name: string): Promise<boolean> {
    const api = q as unknown as McpAuthMethods;
    if (typeof api.mcpSubmitOAuthCallbackUrl !== "function") return false;
    try {
        await withTimeout(api.mcpSubmitOAuthCallbackUrl(name, "http://localhost/callback"), 5000);
        return false;
    } catch (e) {
        return /No active OAuth flow/i.test((e as Error)?.message ?? "");
    }
}

async function pollMcpLogin(flow: McpLogin) {
    flow.timer = null;
    const q = flow.idle?.q;
    if (flow.closed || !q) return;
    if (Date.now() > flow.deadline) {
        endMcpLogin(flow, {phase: "error", error: "5분 안에 로그인을 마치지 않아 취소했습니다"});
        return;
    }
    let list: McpServerStatus[] | null = null;
    try {
        list = await withTimeout(q.mcpServerStatus(), 5000);
        flow.statusErrors = 0;
    } catch (e) {
        if (flow.closed) return;
        if (++flow.statusErrors >= 3) {
            endMcpLogin(flow, {phase: "error", error: "Claude CLI가 응답하지 않아 로그인을 멈췄습니다", detail: (e as Error)?.message});
            return;
        }
    }
    if (flow.closed) return;
    const me = list?.find((m) => m.name === flow.name);
    if (me && me.status !== "connected") flow.sawUnconnected = true;
    if (list && me?.status === "connected" && (flow.sawUnconnected || flow.endedAt)) {
        // 그 폴더 탭들의 목록을 먼저 바꾸고 "done"을 보낸다 — 줄이 "인증 필요"로 잠깐 돌아갔다 바뀌지 않게
        refreshMcpEverywhere(flow.name, {cwd: flow.cwd, list});
        endMcpLogin(flow, {phase: "done"});
        return;
    }
    if (!flow.endedAt && (await mcpLoginEnded(q, flow.name))) flow.endedAt = Date.now();
    if (flow.closed) return;
    if (flow.endedAt) {
        if (me?.status === "failed") {
            endMcpLogin(flow, {phase: "error", error: "로그인은 됐지만 서버에 연결하지 못했습니다", detail: me.error});
            return;
        }
        if (Date.now() - flow.endedAt > MCP_LOGIN_END_GRACE_MS) {
            endMcpLogin(flow, {
                phase: "error",
                error: "로그인을 마치지 못했습니다 — 브라우저에서 거절했거나 서버가 받아 주지 않았습니다",
            });
            return;
        }
    }
    flow.timer = setTimeout(() => void pollMcpLogin(flow), MCP_LOGIN_POLL_MS);
}

// 서버의 로그인 정보가 바뀌었다(로그인·로그아웃·claude.ai 연결). 토큰은 폴더와 무관하므로 모든 폴더의 CLI 정보를 버리고 다시
// 살펴본다(폴더마다 CLI 하나 — 그 서버의 MCP 프롬프트가 명령 목록에 들고 나므로 명령도 같이). 방금 확인한 폴더(fresh)의 탭에는
// 그 목록을 먼저 보낸다 — 다시 살펴보는 몇 초 동안 줄이 옛 상태로 남지 않게. 살아 있는 세션은 그 서버만 다시 연결한다.
// except = 이미 스스로 다시 연결한 세션(로그아웃을 한 세션) — 다시 연결하지 않고 목록만 보낸다.
function refreshMcpEverywhere(name: string, fresh: {cwd: string; list: McpServerStatus[]} | null, except?: LiveSession) {
    folderInfo.clear();
    // 다른 서버가 아직 연결 중인 목록은 보내지 않는다 — 잠깐 "연결 중"으로 보였다가 돌아온다(다시 살펴본 목록이 곧 온다)
    if (fresh?.list.some((m) => m.status === "pending")) fresh = null;
    for (const tab of tabs.values()) {
        const s = tab.live;
        if (s && !s.inputEnded && !s.stopped && s !== except) {
            void reconnectLiveMcp(s, name);
            continue;
        }
        if (fresh && tab.cwd === fresh.cwd) send(tab, "chat:mcp", toMcpList(fresh.list));
        pushFolderInfo(tab);
    }
}

// 살아 있는 세션(응답 중이거나 백그라운드 작업이 도는 탭)이 그 서버를 쓰면 다시 연결한다 — 재시작 없이 새 토큰을 쓰게(로그인),
// 지운 토큰을 더는 쓰지 않게(로그아웃). 다른 CLI 프로세스도 다시 연결하면 저장소에서 새 토큰을 읽는다(실측). 연결되지 않으면
// 예외가 난다("Server status: needs-auth") — 상태는 그대로 보낸다.
async function reconnectLiveMcp(s: LiveSession, name: string) {
    try {
        const list = await withTimeout(s.q.mcpServerStatus(), 5000);
        if (list.some((m) => m.name === name)) await withTimeout(s.q.reconnectMcpServer(name), 30_000);
    } catch (e) {
        console.error("[mcp] 다시 연결 실패", name, (e as Error)?.message);
    }
    if (!s.stopped) pushFolderInfo(s.tab);
}

// 별칭(opus/sonnet…)이 아니라 실제 모델 ID로 비교한다
function currentModelInfo(tab: ChatTab): ModelInfo | undefined {
    return modelCache?.find((m) => (m.resolvedModel ?? m.value) === tab.model || m.value === tab.model);
}

// 목록을 아직 못 받았으면 지원한다고 가정하고 CLI 판단에 맡긴다
function modelSupportsEffort(tab: ChatTab): boolean {
    const info = currentModelInfo(tab);
    return !info || info.supportsEffort === true;
}

function modelSupportsAdaptiveThinking(tab: ChatTab): boolean {
    const info = currentModelInfo(tab);
    return !info || info.supportsAdaptiveThinking === true;
}

function modelSupportsFastMode(tab: ChatTab): boolean {
    const info = currentModelInfo(tab);
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
function searchFilesInCwd(root: string, query: string, limit = 50): string[] {
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
// 화면도 이 글을 다시 읽어 답변 속 질문 카드에 "내 답"을 보여 준다(src/renderer/question-answers.ts) —
// 형식을 바꾸면 그쪽 파서도 같이 바꿀 것. 질문마다 순서대로 "- 이름: 답" 한 줄이고, 답 안에서
//   고른 선택지는 ", "로 잇고, 직접 입력은 "Other: "로 시작하는 줄로 따로 둔다(도구가 직접 입력을 부르는 이름).
//   예전에는 둘을 ", "로 이어 붙여 화면에서 어디까지가 선택지인지 가를 수 없었다.
//   여러 줄은 둘째 줄부터 두 칸 들여 쓴다 — 그래야 답 안의 "- "로 시작하는 줄이 다음 질문으로 읽히지 않는다.
//   모델은 이 형식을 그대로 읽는다(확인함).
const QUESTION_ANSWER_PREFIX = "The user answered:";
const QUESTION_OTHER_PREFIX = "Other: ";
function formatQuestionAnswers(questions: AskQuestion[], answers: string[][]): string {
    const lines = questions.map((q, i) => {
        // 질문 창은 [고른 선택지들, 직접 입력]을 보낸다 — 선택지 이름과 같으면 고른 것, 아니면 직접 입력
        const given = (answers[i] ?? []).map((a) => a.trim()).filter(Boolean);
        const labels = new Set(q.options.map((o) => o.label));
        const picks = given.filter((a) => labels.has(a));
        const custom = given.filter((a) => !labels.has(a)).join("\n");
        const parts: string[] = [];
        if (picks.length > 0) parts.push(picks.join(", "));
        if (custom) parts.push(QUESTION_OTHER_PREFIX + custom);
        const text = parts.length > 0 ? parts.join("\n") : "(skipped)";
        return `- ${q.header || q.question}: ${text.replace(/\n/g, "\n  ")}`;
    });
    return `${QUESTION_ANSWER_PREFIX}\n${lines.join("\n")}`;
}

// 도구 결과 미리보기 — 화면에는 앞부분만 보낸다. 질문의 답(위 형식)은 질문 카드가 통째로 다시 읽으므로 넉넉히.
function toolResultPreview(text: string): string {
    return text.slice(0, text.startsWith(QUESTION_ANSWER_PREFIX) ? 4000 : 500);
}

type PendingPermission = (result: PermissionResult) => void;
// 답을 기다리는 권한 요청·질문 (요청 id → 어느 탭의 것인지 + 답을 돌려줄 함수). id는 모든 탭에서 겹치지 않는다.
const pendingPermissions = new Map<string, {tab: ChatTab; settle: PendingPermission}>();
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

function emptyGrants(): SessionGrants {
    return {tools: [], directories: [], acceptEdits: false};
}

function currentGrants(tab: ChatTab): SessionGrants {
    if (!tab.sessionId) return tab.unsavedGrants;
    let g = grantsBySession.get(tab.sessionId);
    if (!g) {
        g = emptyGrants();
        grantsBySession.set(tab.sessionId, g);
    }
    return g;
}

// 새 대화의 첫 응답에서 세션 ID가 정해질 때 호출한다
function adoptUnsavedGrants(tab: ChatTab, sid: string) {
    const g = tab.unsavedGrants;
    tab.unsavedGrants = emptyGrants();
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

function rememberSessionUpdates(tab: ChatTab, updates: PermissionUpdate[]) {
    const g = currentGrants(tab);
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
    tab: ChatTab,
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
    if (!questions && tab.skipPermissions) return Promise.resolve({behavior: "allow"});

    return new Promise((settle) => {
        const id = `perm-${++permissionSeq}`;
        pendingPermissions.set(id, {tab, settle});

        if (questions) {
            pendingQuestions.set(id, questions);
            send(tab, "chat:question_request", {id, questions});
            opts.signal.addEventListener("abort", () => {
                if (pendingPermissions.delete(id)) {
                    pendingQuestions.delete(id);
                    send(tab, "chat:permission_resolved", {id});
                    settle({behavior: "deny", message: "The user did not answer the questions."});
                }
            });
            return;
        }

        const updates = toSessionUpdates(opts.suggestions);
        if (updates.length > 0) pendingSuggestions.set(id, updates);
        send(tab, "chat:permission_request", {
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
                send(tab, "chat:permission_resolved", {id});
                settle({behavior: "deny", message: "요청이 취소되었습니다"});
            }
        });
    });
}

function buildExtraArgs(tab: ChatTab): Record<string, string | null> {
    const extra: Record<string, string | null> = {};
    // --effort ultracode는 CLI가 거부한다. 세션 설정 키로 넘겨야 한다.
    // fastMode도 같은 설정 레이어 키라 한 JSON에 같이 싣는다(--settings는 하나뿐).
    const overlay: Record<string, boolean> = {};
    if (tab.ultracode) overlay.ultracode = true;
    if (tab.fastMode && modelSupportsFastMode(tab)) overlay.fastMode = true;
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
    tab: ChatTab;
    key: string;
    turnActive: boolean;
    turnResolve: (() => void) | null;
    // 이번 턴에 보낸 사용자 메시지의 uuid. 자동 후속 턴이면 null.
    turnUuid: string | null;
    // 백그라운드 작업이 도는 채로 응답(지금 턴)만 멈췄다 — 그 턴이 정리될(result가 올) 때까지 남은 메시지를 버리고,
    // 다음 메시지는 그 뒤에 보낸다(stopTurnOnly). endInterrupt를 부르면 끝난다.
    interrupting: Promise<void> | null;
    endInterrupt: (() => void) | null;
    backgroundTasks: number;
    // 백그라운드 작업 상세 — 상단 "백그라운드 N" 패널에 보여준다
    bgMembers: Map<string, BgMember>; // 지금 살아 있는 작업 (background_tasks_changed 기준)
    taskInfo: Map<string, TaskDetail>; // task_started/progress/updated로 모은 정보
    toolInputs: Map<string, unknown>; // tool_use id → 입력 (셸 작업의 명령을 찾으려고)
    outputFiles: Map<string, string>; // 셸 작업 id → CLI가 출력을 쓰는 파일
    idleTimer: ReturnType<typeof setTimeout> | null;
    // 이 프로세스가 다음 요청 추천을 낸다 (띄울 때의 설정) — 응답이 끝나도 추천이 올 때까지 입력을 열어 둔다
    suggestions: boolean;
    // 지금 입력을 열어 둔 이유가 추천 기다리기다 (idleTimer = 그 대기 시간). 백그라운드 작업이 끝나 후속 턴을
    // 기다리는 idleTimer와 구분한다 — 그때 온 추천이 그 대기까지 끊으면 안 된다.
    waitingSuggestion: boolean;
    errorSent: boolean;
    stderrTail: string;
    stopped: boolean;
    ended: Promise<void>;
}

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
    // 에이전트가 모델 호출에 쓴 토큰 합계(입력·캐시·출력) — 서브에이전트 응답의 usage를 응답(message.id)마다 한 번씩 더한다.
    // totalTokens(CLI의 "N tokens")는 마지막 응답의 컨텍스트 크기라, 탭 누적 사용량(modelUsage)과 같은 셈이 아니다.
    usedTokens?: number;
    msgTokens?: Map<string, number>;
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

function clipText(text: unknown): string {
    const s = typeof text === "string" ? text : "";
    return s.length > MAX_HUNK_CHARS ? s.slice(0, MAX_HUNK_CHARS) + "\n… (너무 길어서 생략)" : s;
}

// CLI는 작업 폴더의 실제 경로로 일한다(/tmp → /private/tmp 같은 심볼릭 링크가 풀린 경로).
// 패널의 트리는 앱이 아는 작업 폴더 경로로 그리므로, 그 안의 파일이면 같은 표기로 맞춘다.
function toCwdPath(cwd: string, abs: string): string {
    const realCwd = realOrResolved(cwd);
    if (realCwd !== cwd && isInside(realCwd, abs)) return path.join(cwd, path.relative(realCwd, abs));
    return abs;
}

// 결과를 기다리는 수정 (ChatTab.pendingEdits)
interface PendingEdit {
    path: string;
    tool: string;
    hunks: Omit<FileHunk, "at">[];
}

function editOf(tab: ChatTab, name: string, input: unknown): PendingEdit | null {
    if (!EDIT_TOOLS.has(name) || !input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const p = typeof o.file_path === "string" ? o.file_path : typeof o.notebook_path === "string" ? o.notebook_path : "";
    if (!p) return null;
    const abs = toCwdPath(tab.cwd, path.resolve(tab.cwd, p));
    if (name === "Edit") {
        return {path: abs, tool: name, hunks: [{tool: name, oldText: clipText(o.old_string), newText: clipText(o.new_string)}]};
    }
    if (name === "Write") return {path: abs, tool: name, hunks: [{tool: name, oldText: "", newText: clipText(o.content)}]};
    if (name === "MultiEdit") {
        const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [];
        return {
            path: abs,
            tool: name,
            hunks: edits.map((e) => ({tool: name, oldText: clipText(e?.old_string), newText: clipText(e?.new_string)})),
        };
    }
    return {path: abs, tool: name, hunks: [{tool: name, oldText: "", newText: clipText(o.new_source)}]};
}

// 끝난 수정 하나 (onEdited에 넘긴다) — 도구 이름, Write면 쓴 내용(앞 200K), Write가 새 파일을 만들었는지(모르면 undefined),
// 검토 대기로 실제로는 쓰지 않았는지(staged)
interface EditDone {
    tool: string;
    content?: string;
    created?: boolean;
    staged: boolean;
}

// Write·Edit 결과의 구조화된 내용(SDK user 메시지의 tool_use_result — FileWriteOutput {type: "create" | "update", filePath,
// staged?}). 그 메시지의 결과가 이것 하나일 때만 믿는다. 없으면 결과 글: 새 파일이면 "File created successfully at: …".
function editOutcome(msg: unknown, b: {content?: unknown}, results: number, filePath: string): {created?: boolean; staged: boolean} {
    const out = results === 1 ? (msg as {tool_use_result?: unknown}).tool_use_result : undefined;
    if (out && typeof out === "object") {
        const o = out as {type?: unknown; filePath?: unknown; staged?: unknown};
        if (typeof o.filePath !== "string" || path.basename(o.filePath) === path.basename(filePath)) {
            const created = o.type === "create" ? true : o.type === "update" ? false : undefined;
            return {created, staged: o.staged === true};
        }
    }
    const text = contentText(b.content).trimStart();
    return {created: text.startsWith("File created") ? true : text.startsWith("The file ") ? false : undefined, staged: false};
}

// 메시지에서 파일 수정을 찾는다: 도구 호출을 기억해 두었다가 결과가 성공이면 반영. 바뀌었으면 true.
// 세션 기록(SessionMessage)도 같은 모양(type/message/parent_tool_use_id)이라 그대로 넣어도 된다.
// at: 수정 시각. 실시간이면 지금, 세션 기록에서 다시 계산할 때는 그 항목의 시각(entryTime).
// onEdited: 성공한 수정마다 그 경로로 부른다(실시간만 — 지침 파일을 고쳤으면 지침 패널을 새로 계산하려고, 기억이면 알림).
function trackFileEdits(
    tab: ChatTab,
    msg: {type: string; message?: unknown},
    at = Date.now(),
    onEdited?: (path: string, done: EditDone) => void
): boolean {
    const content = (msg.message as {content?: unknown} | undefined)?.content;
    if (!Array.isArray(content)) return false;
    type Block = {type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown};
    const blocks = content as Block[];
    const results = blocks.filter((b) => b?.type === "tool_result").length;
    let changed = false;
    for (const b of blocks) {
        if (msg.type === "assistant" && b.type === "tool_use" && b.id && b.name) {
            const e = editOf(tab, b.name, b.input);
            if (e) tab.pendingEdits.set(b.id, e);
        }
        if (msg.type === "user" && b.type === "tool_result" && b.tool_use_id) {
            const p = tab.pendingEdits.get(b.tool_use_id);
            if (!p) continue;
            tab.pendingEdits.delete(b.tool_use_id);
            if (b.is_error) continue;
            // 내역을 지운 시각 이전에 끝난 수정 — 지운 내역이다
            if (at <= tab.changesClearedAt) continue;
            const f = tab.changedFiles.get(p.path) ?? {path: p.path, edits: 0, lastTurn: tab.fileTurn, lastAt: at, hunks: []};
            f.edits += 1;
            f.lastTurn = tab.fileTurn;
            f.lastAt = at;
            f.hunks = [...f.hunks, ...p.hunks.map((h) => ({...h, at}))].slice(-MAX_HUNKS_PER_FILE);
            tab.changedFiles.set(p.path, f);
            changed = true;
            if (onEdited) {
                const written = p.tool === "Write" ? p.hunks[0]?.newText : undefined;
                onEdited(p.path, {tool: p.tool, content: written, ...editOutcome(msg, b, results, p.path)});
            }
        }
    }
    return changed;
}

function changedFileList(tab: ChatTab) {
    return {
        turn: tab.fileTurn,
        files: [...tab.changedFiles.values()].map((f) => ({path: f.path, edits: f.edits, lastTurn: f.lastTurn, lastAt: f.lastAt})),
        clearedAt: tab.changesClearedAt || undefined,
    };
}

function sendChangedFiles(tab: ChatTab) {
    send(tab, "files:changed", changedFileList(tab));
}

function resetChangedFiles(tab: ChatTab) {
    tab.changedFiles.clear();
    tab.pendingEdits.clear();
    tab.fileTurn = 0;
    tab.changedFilesGen++;
    tab.changesClearedAt = 0;
}

// "Claude 수정" 내역을 지운 시각 — 대화(세션)별로 기억한다. 대화를 다시 열면(앱 재시작 포함) 고친 파일을
// 세션 기록 전체에서 다시 계산하므로, 이걸 기억하지 않으면 지운 내역이 그대로 되살아난다.
// userData/changes-cleared.json = {세션 id: 지운 시각(ms)}, 최근 것 200개까지만.
const CLEARED_KEEP = 200;
let clearedAtCache: Record<string, number> | null = null;

function clearedFile(): string {
    return path.join(app.getPath("userData"), "changes-cleared.json");
}

function clearedAtBySession(): Record<string, number> {
    if (!clearedAtCache) {
        const raw = readJsonFile<unknown>(clearedFile(), {});
        clearedAtCache = {};
        if (raw && typeof raw === "object") {
            for (const [sid, at] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof at === "number" && Number.isFinite(at)) clearedAtCache[sid] = at;
            }
        }
    }
    return clearedAtCache;
}

function saveClearedAt(sid: string, at: number) {
    const map = {...clearedAtBySession(), [sid]: at};
    clearedAtCache = Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, CLEARED_KEEP));
    try {
        writeJsonFile(clearedFile(), clearedAtCache);
    } catch (e) {
        console.error("[files] 내역 지운 시각 저장 실패", e);
    }
}

// 앱이 갈라낸 대화(forkSession)와 갈라낸 지점. 갈라낸 대화는 파일 되돌리기 기록을 가져오지 않아서
// 복사된 메시지로는 파일을 되돌릴 수 없다(실측: "No file checkpoint found for this message."). 기록 파일에는
// 항목마다 forkedFrom이 남지만 getSessionMessages가 넘겨주지 않아(확인함) 앱이 직접 기억한다 —
// 복사된 메시지에서 "파일 되돌리기"를 숨기려고. userData/fork-points.json = {갈라낸 세션 id: {until, at}}
// (until = 복사된 마지막 항목의 uuid), 최근 200개.
const FORK_KEEP = 200;
interface ForkPoint {
    until: string;
    at: number;
}
let forkPointsCache: Record<string, ForkPoint> | null = null;

function forkPointsFile(): string {
    return path.join(app.getPath("userData"), "fork-points.json");
}

function forkPoints(): Record<string, ForkPoint> {
    if (!forkPointsCache) {
        const raw = readJsonFile<unknown>(forkPointsFile(), {});
        forkPointsCache = {};
        if (raw && typeof raw === "object") {
            for (const [sid, v] of Object.entries(raw as Record<string, unknown>)) {
                const fp = v as Partial<ForkPoint> | null;
                if (fp && typeof fp.until === "string" && typeof fp.at === "number") forkPointsCache[sid] = {until: fp.until, at: fp.at};
            }
        }
    }
    return forkPointsCache;
}

function saveForkPoints(map: Record<string, ForkPoint>) {
    forkPointsCache = Object.fromEntries(Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, FORK_KEEP));
    try {
        writeJsonFile(forkPointsFile(), forkPointsCache);
    } catch (e) {
        console.error("[fork] 갈라낸 지점 저장 실패", e);
    }
}

// 세션 기록 항목의 시각. SDK 타입에는 없지만 실제 항목에는 timestamp(ISO 문자열)가 들어 있다(확인함).
// 이걸 안 쓰면 변경 내역의 시각이 전부 "대화를 연 시각"으로 찍혔다(재현됨). 없으면 0 = 모름.
function entryTime(e: unknown): number {
    const t = Date.parse(String((e as {timestamp?: unknown}).timestamp ?? ""));
    return Number.isFinite(t) ? t : 0;
}

// ── 대화별 비용·컨텍스트 (작업 폴더 줄의 "$0.12", 컨텍스트 게이지) ──
// 둘 다 응답이 끝날 때만 CLI가 알려 준다. 그래서 앱을 다시 켜거나 지난 대화를 열면 다음 응답 전까지 비어 있었다.
// 받을 때마다 대화별로 저장해 두고(userData/session-stats.json, 최근 300개), 대화를 열 때 다시 보낸다.
// 앱 밖(터미널)에서 이어 쓴 대화는 저장한 값이 낡았다 — 그때는 기록의 마지막 응답 사용량으로 컨텍스트만 다시 계산한다
// (CLI의 getContextUsage "summary"도 마지막 응답의 사용량으로 계산한다). 비용은 다시 계산할 방법이 없어 보이지 않는다.
interface ApiUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
interface ContextStat {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
}
// 대화의 누적 토큰 — result.modelUsage(모델별 합)를 더한 것. 본 대화·에이전트(Task)·요약 등 모든 모델 호출이 들어가고,
// 턴마다 누계가 오며, 이어 쓴 대화는 기록에 저장된 누계부터 이어 간다(SDK 설명). /cost가 보여 주는 숫자와 같은 셈이다.
interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
interface SavedSessionStat {
    cost?: number;
    context?: ContextStat;
    usage?: TokenTotals;
    at: number; // 저장한 시각(epoch ms)
}
interface SessionStatsFile {
    sessions: Record<string, SavedSessionStat>;
    maxTokensByModel: Record<string, number>; // 모델별 컨텍스트 크기 — 다시 계산할 때 게이지의 분모
}

const SESSION_STATS_KEEP = 300;
let sessionStatsCache: SessionStatsFile | null = null;

function sessionStatsFile(): string {
    return path.join(app.getPath("userData"), "session-stats.json");
}

function sessionStats(): SessionStatsFile {
    if (!sessionStatsCache) {
        const raw = readJsonFile<Partial<SessionStatsFile>>(sessionStatsFile(), {});
        sessionStatsCache = {
            sessions: raw && typeof raw.sessions === "object" && raw.sessions ? raw.sessions : {},
            maxTokensByModel: raw && typeof raw.maxTokensByModel === "object" && raw.maxTokensByModel ? raw.maxTokensByModel : {},
        };
    }
    return sessionStatsCache;
}

function saveSessionStats(sid: string, update: {cost?: number; context?: ContextStat; model?: string; usage?: TokenTotals}) {
    const stats = sessionStats();
    const prev = stats.sessions[sid];
    stats.sessions[sid] = {
        cost: update.cost ?? prev?.cost,
        context: update.context ?? prev?.context,
        usage: update.usage ?? prev?.usage,
        at: Date.now(),
    };
    if (update.context && update.model && update.context.maxTokens > 0) stats.maxTokensByModel[update.model] = update.context.maxTokens;
    stats.sessions = Object.fromEntries(Object.entries(stats.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, SESSION_STATS_KEEP));
    try {
        writeJsonFile(sessionStatsFile(), stats);
    } catch (e) {
        console.error("[stats] 저장 실패", e);
    }
}

// 응답 하나가 처리한 토큰 (입력 + 캐시 쓰기·읽기 + 출력)
function tokensOf(u: ApiUsage): number {
    return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
}

function totalsFromModelUsage(raw: unknown): TokenTotals | null {
    if (!raw || typeof raw !== "object") return null;
    const t: TokenTotals = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    for (const m of Object.values(raw as Record<string, Record<string, unknown>>)) {
        if (!m || typeof m !== "object") continue;
        t.input += num(m.inputTokens);
        t.output += num(m.outputTokens);
        t.cacheRead += num(m.cacheReadInputTokens);
        t.cacheWrite += num(m.cacheCreationInputTokens);
    }
    return t.input + t.output + t.cacheRead + t.cacheWrite > 0 ? t : null;
}

function restoreSessionStats(tab: ChatTab, sid: string, lastUsage: ApiUsage | null, lastModel: string, lastAt: number) {
    if (tab.sessionId !== sid) return; // 읽는 사이 다른 대화로 옮겼다
    const stats = sessionStats();
    const saved = stats.sessions[sid];
    // 앱에서 마지막으로 받은 값이 기록의 끝보다 나중이면 그대로 쓴다 (응답이 끝난 뒤에 저장하므로)
    if (saved && saved.at >= lastAt) {
        if (typeof saved.cost === "number") send(tab, "chat:cost", {totalCostUsd: saved.cost, usage: saved.usage});
        if (saved.context) send(tab, "chat:context", saved.context);
        return;
    }
    if (!lastUsage) return;
    // CLI(getContextUsage "summary")와 같은 셈: 마지막 요청에 들어간 입력(캐시 포함)만 센다 — 그 답의 출력은 빼고.
    // 출력까지 더했더니 앱이 받았던 값보다 정확히 그 답의 출력 토큰만큼 많았다(38,568 vs 38,473).
    const total =
        (lastUsage.input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0);
    const max = stats.maxTokensByModel[lastModel] ?? saved?.context?.maxTokens;
    if (!max || total <= 0) return;
    send(tab, "chat:context", {totalTokens: total, maxTokens: max, percentage: Math.round((total / max) * 100)});
}

// 저장된 대화를 열면 세션 기록에서 고친 파일을 다시 계산한다 (서브에이전트 항목 포함).
// 반영했으면 true. 읽는 사이 새 대화·다른 대화·폴더 변경이 있었으면 아무것도 바꾸지 않고 false.
async function loadChangedFilesFromSession(tab: ChatTab, sid: string): Promise<boolean> {
    resetChangedFiles(tab);
    tab.changesClearedAt = clearedAtBySession()[sid] ?? 0;
    const gen = tab.changedFilesGen;
    try {
        const {getSessionMessages} = await loadSdk();
        const entries = await getSessionMessages(sid);
        if (gen !== tab.changedFilesGen) return false;
        let lastUsage: ApiUsage | null = null;
        let lastModel = "";
        let lastAt = 0;
        for (const e of entries) {
            if (e.type === "user" && !e.parent_tool_use_id) {
                const c = (e.message as {content?: unknown} | undefined)?.content;
                const isPrompt = typeof c === "string" || (Array.isArray(c) && !c.some((b) => (b as {type?: string})?.type === "tool_result"));
                // 응답 도중 끼워진 작업 완료 알림은 새 턴이 아니다 (답이 끝난 뒤 온 알림은 CLI의 후속 턴 — 실시간도 센다)
                if (isPrompt && taskNotificationKind(e) !== "queued") tab.fileTurn += 1;
            }
            trackFileEdits(tab, e, entryTime(e));
            // 슬래시 명령의 출력 줄("<local-command-stdout>Compacted")은 CLI가 result를 낸 뒤에 적어서 앱이 통계를
            // 저장한 시각보다 늦게 찍힌다 — 세면 /compact 직후 다시 열 때마다 "터미널에서 이어 쓴 대화"로 보고
            // 저장값을 버렸다(재현됨). 컨텍스트를 바꾸지 않는 줄이라 뺀다.
            if (!contentText((e.message as {content?: unknown} | undefined)?.content).includes("<local-command-stdout>")) {
                lastAt = Math.max(lastAt, entryTime(e));
            }
            const m = e.message as {model?: string; usage?: ApiUsage} | undefined;
            if (e.type === "assistant" && !e.parent_tool_use_id && m?.usage) {
                lastUsage = m.usage;
                lastModel = m.model ?? "";
            }
        }
        restoreSessionStats(tab, sid, lastUsage, lastModel, lastAt);
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
function canViewPath(tab: ChatTab, p: unknown): p is string {
    if (typeof p !== "string" || !path.isAbsolute(p)) return false;
    if (tab.changedFiles.has(p)) return true;
    return isInside(realOrResolved(tab.cwd), realOrResolved(p));
}

const HIDDEN_ENTRIES = new Set([".git", ".DS_Store"]);
const MAX_DIR_ENTRIES = 2000;

function listDir(tab: ChatTab, dir: unknown) {
    if (!canViewPath(tab, dir)) return null;
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

function readFileForView(tab: ChatTab, p: unknown) {
    if (!canViewPath(tab, p)) return {error: "볼 수 없는 경로입니다"};
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
        // 그림 파일 — 화면이 images:read로 그림을 받아 그린다. svg는 글자이기도 해서 소스도 같이 준다.
        const mime = sniffImage(buf.subarray(0, Math.min(len, 4096)), p);
        if (mime === "image/svg+xml") {
            return {image: true, mime, size: st.size, text: buf.toString("utf8"), truncated: st.size > MAX_VIEW_BYTES};
        }
        if (mime) return {image: true, mime, size: st.size};
        // 앞부분에 NUL 바이트가 있으면 이진 파일로 본다
        if (buf.subarray(0, Math.min(len, 8000)).includes(0)) return {binary: true, size: st.size};
        return {text: buf.toString("utf8"), truncated: st.size > MAX_VIEW_BYTES, size: st.size};
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" ? {missing: true} : {error: "파일을 읽을 수 없습니다 (권한 등)"};
    }
}

// 이 대화에서 최근에 끝난 백그라운드 작업 (최신순). CLI 프로세스가 끝나도 남도록 세션 밖에 둔다.
// 대화를 바꾸면 비운다(tabs:open / 폴더 변경 / 대화 삭제).
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
    terminated?: boolean; // 다른 명령이 신호로 끝냈다 — status는 stopped, 화면엔 "종료됨"
    hasOutput: boolean;
    recentTools?: ToolStep[];
    launchedByAgent?: boolean;
    toolUseId?: string; // 이 작업을 띄운 도구 호출 — 답변 속 그 줄에 상태를 보인다
    parentTaskId?: string; // 에이전트가 띄운 작업이면 그 에이전트(작업 id)
    usedTokens?: number; // 에이전트가 쓴 토큰 합계 (TaskDetail.usedTokens)
}

const MAX_FINISHED = 10;

function clearFinishedTasks(tab: ChatTab) {
    tab.finishedTasks = [];
    tab.finishedOutputFiles.clear();
    send(tab, "chat:background", {running: [], finished: []});
}

// 셸 작업을 백그라운드로 돌리면 tool_result에 출력 파일 경로가 온다(실측)
const BG_OUTPUT_RE = /background with ID: ([\w-]+)\. Output is being written to: (\S+?\.output)/;

// 화면에 보일 도구 결과 글. 내용 블록 배열이면 글 블록만 — 예전에는 배열을 JSON째 보여서
// 그림(Read로 연 그림 등)의 base64가 미리보기에 찍혔다.
function toolResultDisplayText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return toolResultText(content).trim();
    return JSON.stringify(content ?? "");
}

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
    // 에이전트가 쓴 토큰 — 한 응답이 내용 블록마다 여러 메시지로 오고 usage가 반복되므로 응답마다 한 번(큰 값)만 센다
    if (agent && msg.type === "assistant") {
        const m = (msg as {message?: {id?: string; usage?: ApiUsage}}).message;
        if (m?.id && m.usage) {
            const n = tokensOf(m.usage);
            const seen = (agent.msgTokens ??= new Map());
            const prev = seen.get(m.id) ?? 0;
            if (n > prev) {
                seen.set(m.id, n);
                agent.usedTokens = (agent.usedTokens ?? 0) + n - prev;
                changed = true;
            }
        }
    }
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

// 화면에 보낼 백그라운드 작업: 실행 중(내부용 ambient 작업 제외) + 이 대화에서 최근 끝난 것.
// 멈춘·닫는 세션(stopped)의 목록은 낡았다 — 그 프로세스는 작업째 정리되는 중이고 더는 소식이 오지 않는다. 예전에는
// 그래도 보내서, "모두 중지" 직후 패널의 "지우기"를 누르면 꺼지는 작업이 프로세스가 끝날 때까지 "실행 중"으로 다시 떴다(재현됨).
function sendBackground(s: LiveSession) {
    const list = [...s.bgMembers]
        .filter(([, m]) => !m.ambient && !s.stopped)
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
                toolUseId: d?.toolUseId,
                parentTaskId: m.parentTaskId,
                usedTokens: d?.usedTokens,
            };
        });
    send(s.tab, "chat:background", {running: list, finished: s.tab.finishedTasks});
}

// 백그라운드 작업이 끝났다(task_notification) — 결과를 "최근 끝난 작업"으로 남긴다
// 신호로 끝난 종료 코드(128 + 신호 번호) 중 "누가 끝냈다"는 것 — 프로그램이 스스로 죽은 신호(ABRT·SEGV·BUS…)는 넣지 않는다
const TERMINATED_EXIT_CODES = new Set([129, 130, 137, 143, 144]);

// 스스로 끝나지 않는 명령(dev 서버·감시·무한 반복) — 누가 끌 때가 정상적인 끝이라, 신호로 끝나면 "완료"로 본다.
// 명령 이름으로 짐작한다(가끔 틀린다). 경로 속 단어(/dev/null, src/server.ts)는 앞이 /·글자면 빼고, vite build는 뺀다.
// 명령으로 못 알아보는 것(node src/server/index.js …)은 Claude가 붙인 설명("Start dev server …")으로 본다.
// 예시 51개(서버 25 · 빌드·테스트 등 16 · 설명 10)로 맞춰 봤다.
const LONG_RUNNING_COMMAND =
    /(?<![/\w.-])(dev|serve|server|runserver|start|preview|watch|nodemon|uvicorn|gunicorn|http-server|live-server)\b|--watch\b|(?<![/\w.-])vite\b(?!\s+build)|\bhttp\.server\b|SimpleHTTPServer|\btail\b[^|;&\n]*\s-[a-zA-Z]*[fF]\b|\bwhile\s+(true|:)/i;
const LONG_RUNNING_DESCRIPTION = /dev\s*server|\bserver\b(?!\.\w)|\bwatch(er|ing)?\b|서버|감시/i;

function looksLongRunning(command: string | undefined, description: string | undefined): boolean {
    return (!!command && LONG_RUNNING_COMMAND.test(command)) || (!!description && LONG_RUNNING_DESCRIPTION.test(description));
}

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
    if (outputFile) s.tab.finishedOutputFiles.set(n.task_id, outputFile);
    // 종료 코드: 요약 문구("… failed with exit code 1")에서 먼저 읽는다. 이 시점엔 출력 파일 끝의
    // "[exited with code N]" 줄이 아직 안 쓰였을 수 있다(실측).
    const code =
        n.summary?.match(/exit code (\d+)/) ??
        (outputFile ? readOutputTail(outputFile, 400)?.text.match(/\[exited with code (\d+)\]\s*$/) : null);
    const exitCode = code ? Number(code[1]) : undefined;
    // 다른 명령이 신호로 끝낸 셸은 실패가 아니다 — CLI는 종료 코드만 보고 failed로 알린다. 흔한 경우: Claude가 dev 서버를
    // 다시 띄우려고 이전 것을 kill/pkill (143 = SIGTERM), Ctrl-C(130), 창 닫힘(129), kill -9(137), pkill된 Electron(144 — 실측).
    // 실제 기록 집계: "실패" 77건 중 74건이 143·144였다. 스스로 죽은 경우(134 SIGABRT, 139 SIGSEGV …)와 일반 오류 코드는 그대로 실패.
    const terminated = n.status === "failed" && exitCode !== undefined && TERMINATED_EXIT_CODES.has(exitCode);
    const command = typeof input?.command === "string" ? input.command : undefined;
    // 꺼진 것이 dev 서버·감시 같은 명령이면 그게 정상적인 끝 → 완료(✓). 빌드·테스트 등은 도중에 끊긴 것 → 종료됨(회색)
    const endedNormally = terminated && looksLongRunning(command, m.description);
    const record: FinishedTask = {
        id: n.task_id,
        type: m.type,
        description: m.description,
        subagentType: m.subagentType ?? d?.subagentType,
        workflowName: d?.workflowName,
        command,
        status: endedNormally ? "completed" : terminated ? "stopped" : n.status,
        terminated: terminated || undefined,
        summary: n.summary || undefined,
        startedAt: d?.startedAt,
        endedAt: Date.now(),
        totalTokens: n.usage?.total_tokens ?? d?.totalTokens,
        toolUses: n.usage?.tool_uses ?? d?.toolUses,
        exitCode,
        hasOutput: !!outputFile,
        recentTools: d?.recentTools,
        launchedByAgent: !!m.parentTaskId,
        toolUseId: d?.toolUseId,
        parentTaskId: m.parentTaskId,
        usedTokens: d?.usedTokens,
    };
    s.tab.finishedTasks = [record, ...s.tab.finishedTasks.filter((f) => f.id !== record.id)].slice(0, MAX_FINISHED);
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

// 백그라운드 작업이 모두 끝났는데 후속 턴이 시작되지 않으면 이 시간 뒤 프로세스를 정리한다
const IDLE_END_MS = 60_000;

// 첫 메시지 재생성·편집이 새 세션을 만들지 못하고 끝났을 때 원래 세션으로 되돌린다
function restoreReplaceFirst(tab: ChatTab) {
    const r = tab.replaceFirst;
    if (!r) return;
    // 새 세션이 이미 생겼으면 되돌리지 않는다 — 화면은 새 대화다. 옛 대화는 남아 있고, 이 탭에서 답이 성공하면 그때 지운다.
    if (r.newSid) return;
    // 실패한 재생성 뒤 다시 한 것이었으면 그 앞의 교체(원래 대화를 지울 일)로 돌아간다
    tab.replaceFirst = r.prev ?? null;
    // 새 세션에 주려던 허용 규칙도 원래 세션으로 되돌린다
    const g = tab.unsavedGrants;
    if (g.tools.length > 0 || g.directories.length > 0 || g.acceptEdits) grantsBySession.set(r.oldSid, g);
    tab.unsavedGrants = emptyGrants();
    tab.sessionId = r.oldSid;
}

// 지운 세션에 앱이 따로 붙여 둔 기록(허용 규칙, 갈래 표시)을 정리한다
function forgetSession(sid: string) {
    grantsBySession.delete(sid);
    if (forkPoints()[sid]) {
        const rest = {...forkPoints()};
        delete rest[sid];
        saveForkPoints(rest);
    }
}

// 세션이 지워졌다 — 사이드바가 목록을 다시 받게 한다
function notifySessionsChanged() {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("sessions:changed");
    }
}

// 첫 메시지 재생성·편집이 새 세션에서 성공했다 — 이제 버린 옛 세션을 지운다(같은 대화가 두 개 남지 않게).
// 모델 호출이 있었던 성공만 센다: /cost 같은 로컬 명령도 success(num_turns 0)를 낸다.
// 실패한 동안 옛 대화는 사이드바에 남아 있다. 그걸 다른 탭에서 열어 두었거나 이어 썼으면 지우지 않는다 — 예전에는
// 이어 쓴 내용까지 통째로 지워졌다(검토에서 찾음).
function commitReplaceFirst(tab: ChatTab, msg: {subtype?: string; is_error?: boolean; num_turns?: number}) {
    const r = tab.replaceFirst;
    if (!r?.newSid || tab.sessionId !== r.newSid) return;
    if (msg.subtype !== "success" || msg.is_error || !(msg.num_turns && msg.num_turns > 0)) return;
    tab.replaceFirst = null;
    const olds: ReplaceFirst[] = [];
    for (let n: ReplaceFirst | undefined = r; n; n = n.prev) olds.push(n);
    const openElsewhere = (sid: string) => [...tabs.values()].some((t) => t.sessionId === sid);
    void (async () => {
        const {getSessionMessages, deleteSession} = await loadSdk();
        let deleted = false;
        for (const n of olds) {
            if (openElsewhere(n.oldSid)) continue;
            const entries = await getSessionMessages(n.oldSid).catch(() => null);
            // 못 읽었거나 이미 없거나, 교체를 시작한 뒤 기록이 늘었다(이어 썼다) — 남긴다
            if (!entries || entries.length === 0 || entries[entries.length - 1].uuid !== n.lastUuid) continue;
            if (openElsewhere(n.oldSid)) continue; // 읽는 사이에 열었을 수 있다
            forgetSession(n.oldSid);
            await deleteSession(n.oldSid);
            deleted = true;
        }
        if (deleted) notifySessionsChanged();
    })().catch((e) => console.error("[sessions] 옛 세션 삭제 실패", e));
}

// 재생성·편집: 버릴 사용자 메시지(replaceUuid) 직전 항목의 uuid를 돌려준다. 세션을 그 지점까지만
// 이어가면(resumeSessionAt) 그 메시지와 이후 응답이 모델 기록에서 빠진다 — 화면에서 지우는 범위와 같다.
// 예전에는 같은 세션에 다시 보내기만 해서 모델에게 옛 질문·답이 그대로 남았다(재현됨).
async function prepareReplace(tab: ChatTab, replaceUuid: string): Promise<string | undefined> {
    const sid = tab.sessionId;
    if (!sid) return undefined;
    let entries: SessionMessage[];
    try {
        const {getSessionMessages} = await loadSdk();
        entries = await getSessionMessages(sid);
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
    // 첫 메시지 — 새 세션으로. 실패한 재생성 뒤 또 바꾸는 경우(이 세션이 대기 중인 교체의 새 세션) 그 교체를 이어 둔다:
    // 예전에는 원래 대화를 잊어서, 성공해도 원래 대화와 새 대화가 둘 다 남았다.
    const pending = tab.replaceFirst?.newSid === sid ? tab.replaceFirst : undefined;
    tab.replaceFirst = {oldSid: sid, lastUuid: entries[entries.length - 1]?.uuid ?? "", prev: pending};
    // 이 대화에서 허용한 규칙은 새 세션에도 준다. 옛 대화는 성공 전까지 남으니 옮기지 않고 복사한다.
    const g = grantsBySession.get(sid);
    tab.unsavedGrants = g ? {tools: [...g.tools], directories: [...g.directories], acceptEdits: g.acceptEdits} : emptyGrants();
    tab.sessionId = null;
    return undefined;
}

// query 생성 시점에 고정되는 옵션들. 바뀌면 프로세스를 새로 띄워야 한다.
function optionsKey(tab: ChatTab): string {
    return JSON.stringify([tab.model, effectiveEffort(tab), tab.ultracode, tab.fastMode, tab.skipPermissions, tab.cwd, systemPrompts]);
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
    s.waitingSuggestion = false;
    s.inputEnded = true;
    s.input.end();
}

function hasRunningBackground(s: LiveSession): boolean {
    for (const m of s.bgMembers.values()) if (!m.ambient) return true;
    return false;
}

// 멈추는 중인 턴의 result가 끝내 안 오면(예상 밖) 이 시간 뒤 다시 메시지를 받는다
const INTERRUPT_WAIT_MS = 5000;

// 응답(지금 턴)만 멈춘다 — 프로세스와 백그라운드 작업은 그대로. 렌더러는 이미 턴을 스스로 닫았으므로 chat:done은
// 보내지 않는다(늦게 간 done이 다음 턴을 끝낸다). CLI에는 interrupt(터미널의 Esc와 같다)를 보내고, 그 턴이 정리될
// 때까지 남은 메시지는 pump가 버린다.
function stopTurnOnly(tab: ChatTab, s: LiveSession) {
    tab.stopEpoch++;
    restoreReplaceFirst(tab);
    const wasActive = s.turnActive;
    s.turnActive = false;
    s.turnUuid = null;
    s.turnResolve?.();
    s.turnResolve = null;
    settlePendingPermissions(tab, "사용자가 중지했습니다");
    if (!wasActive || s.endInterrupt) return;
    let release: () => void = () => undefined;
    s.interrupting = new Promise<void>((r) => {
        release = r;
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const end = () => {
        if (timer) clearTimeout(timer);
        if (s.endInterrupt !== end) return;
        s.endInterrupt = null;
        s.interrupting = null;
        release();
    };
    s.endInterrupt = end;
    timer = setTimeout(end, INTERRUPT_WAIT_MS);
    void withTimeout(s.q.interrupt(), INTERRUPT_WAIT_MS).catch(() => end());
}

// 응답과 백그라운드 작업을 모두 멈춘다. 이 순간부터 이 세션의 메시지는 렌더러로 가지 않는다(pump가 버린다).
// 프로세스 정리는 기다리지 않는다 — interrupt로 기록을 정리할 기회를 잠깐 주고 강제 종료(백그라운드 셸도 꺼진다).
function stopEverything(tab: ChatTab) {
    tab.stopEpoch++;
    // 첫 메시지 재생성이 새 세션을 만들기 전에 멈췄으면 원래 대화로 되돌린다
    restoreReplaceFirst(tab);
    const s = tab.live;
    if (!s) return;
    s.stopped = true;
    s.turnActive = false;
    s.turnUuid = null;
    s.turnResolve?.();
    s.turnResolve = null;
    s.endInterrupt?.();
    settlePendingPermissions(tab, "사용자가 중지했습니다");
    endInput(s);
    void (async () => {
        try {
            await withTimeout(s.q.interrupt(), 1000);
        } catch {
            // 무시 — 아래에서 강제 종료
        }
        s.q.close();
    })();
}

// 백그라운드 작업도 같이 종료된다
function closeLive(tab: ChatTab) {
    const s = tab.live;
    if (!s) return;
    s.stopped = true;
    endInput(s);
    s.q.close();
}

// 이 탭의 대기 중인 권한 요청·질문만 거부로 정리한다 — 다른 탭은 계속 답을 기다린다
function settlePendingPermissions(tab: ChatTab, message: string) {
    for (const [id, p] of pendingPermissions) {
        if (p.tab !== tab) continue;
        pendingPermissions.delete(id);
        pendingQuestions.delete(id);
        pendingSuggestions.delete(id);
        p.settle({behavior: "deny", message});
    }
    send(tab, "chat:permission_resolved", {id: null});
}

function beginTurn(s: LiveSession, resolve: (() => void) | null, uuid: string | null) {
    s.tab.streamedMessageIds.clear();
    s.tab.fileTurn += 1;
    // 패널의 "방금" 표시를 새 응답 기준으로 — 지난 응답에서 바뀐 파일은 "수정 N"으로 내려간다
    if (s.tab.changedFiles.size > 0) sendChangedFiles(s.tab);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.waitingSuggestion = false;
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
    restoreReplaceFirst(s.tab);
    // 답을 못 받은 권한 요청이 남아 있으면 렌더러 모달이 영영 안 닫힌다
    settlePendingPermissions(s.tab, "턴이 종료되었습니다");
    send(s.tab, "chat:done");
    s.turnResolve?.();
    s.turnResolve = null;
    s.turnUuid = null;
    // 백그라운드 작업이 없으면 입력을 닫는다 — 닫지 않으면 for await가 다음 메시지를 영원히 기다린다.
    // 다음 요청 추천을 켰으면 추천이 올 때까지(최대 SUGGESTION_WAIT_MS) 열어 둔다. 바로 닫아도 추천은 오지만
    // 그동안 프로세스가 살아 있어서, 그 사이 보낸 메시지가 이 프로세스가 끝나길 2~3초 기다렸다. 열어 두면
    // 그 메시지는 이 프로세스로 곧장 들어간다(백그라운드 작업 때와 같은 길).
    if (s.backgroundTasks === 0) {
        if (s.suggestions && !s.stopped && !s.inputEnded) {
            if (s.idleTimer) clearTimeout(s.idleTimer);
            s.waitingSuggestion = true;
            s.idleTimer = setTimeout(() => {
                s.idleTimer = null;
                s.waitingSuggestion = false;
                if (!s.turnActive && s.backgroundTasks === 0) endInput(s);
            }, SUGGESTION_WAIT_MS);
        } else {
            endInput(s);
        }
    }
}

// 추천은 보통 result 뒤 2~3초에 온다(실측). 안 오는 턴도 있어(할 말이 없을 때, 한도 근처, 계획 모드) 이만큼만 기다린다.
const SUGGESTION_WAIT_MS = 8_000;

async function reportContextUsage(s: LiveSession) {
    try {
        // summary: 마지막 응답의 usage로 계산 — 카테고리별 토큰 카운트 API 호출을 생략한다.
        // CLI가 답하지 않아도 턴 종료가 막히지 않도록 시간 제한을 둔다.
        const usage = await withTimeout(s.q.getContextUsage({detail: "summary"}), 5000);
        // 기다리는 사이 중지됐으면 보내지 않는다
        if (s.stopped) return;
        const context = {totalTokens: usage.totalTokens, maxTokens: usage.rawMaxTokens, percentage: usage.percentage};
        send(s.tab, "chat:context", context);
        if (s.tab.sessionId) saveSessionStats(s.tab.sessionId, {context, model: s.tab.model});
    } catch (e) {
        console.error("[context] 사용량 조회 실패", e);
    }
}

async function startLive(tab: ChatTab, claudePath: string, resumeAt?: string): Promise<LiveSession> {
    const {query} = await loadSdk();
    const input = createInputQueue();
    const grants = currentGrants(tab);
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
            model: tab.model,
            effort: modelSupportsEffort(tab) ? (effectiveEffort(tab) as Options["effort"]) : undefined,
            // 5세대 모델은 사고 내용을 기본으로 숨긴다(display: omitted → 빈 문자열).
            // 요약본을 받아야 ActivityPanel에 사고 과정이 보인다.
            // (Haiku 4.5 같은 구모델은 adaptive를 지원하지 않아 CLI 기본값에 맡긴다)
            thinking: modelSupportsAdaptiveThinking(tab) ? {type: "adaptive", display: "summarized"} : undefined,
            cwd: tab.cwd,
            // 앱이 이미 찾아둔 바로 그 바이너리를 쓴다. 지정하지 않으면 SDK가
            // 자기 번들 바이너리(224MB)를 쓰므로 인증/버전이 갈릴 수 있다.
            pathToClaudeCodeExecutable: claudePath,
            resume: tab.sessionId ?? undefined,
            // 재생성·편집일 때만: 이 지점까지만 이어간다(그 뒤는 모델 기록에서 빠진다)
            resumeSessionAt: tab.sessionId && resumeAt ? resumeAt : undefined,
            permissionMode: tab.skipPermissions ? "bypassPermissions" : grants.acceptEdits ? "acceptEdits" : "default",
            // 답변이 끝나면 "다음 요청" 하나를 추천받는다 (prompt_suggestion, result 뒤 2~3초) — 부모의 프롬프트
            // 캐시를 써서 거의 공짜(SDK 문서). 메시지마다 프로세스를 새로 띄우는 앱 방식에서도 온다(확인함).
            promptSuggestions: promptSuggestionsOn,
            allowedTools: grants.tools.length > 0 ? [...grants.tools] : undefined,
            additionalDirectories: grants.directories.length > 0 ? [...grants.directories] : undefined,
            // 글자 단위 스트리밍(stream_event). 완성된 assistant 메시지도 따로 온다 — handleSdkMessage 참고
            includePartialMessages: true,
            // 메시지 시점으로 파일을 되돌릴 수 있게 수정 전 백업을 남긴다(rewindFiles)
            enableFileCheckpointing: true,
            // 백그라운드 에이전트가 무엇을 하는지 약 30초마다 한 줄 요약(task_progress.summary).
            // 에이전트의 프롬프트 캐시를 재사용해 비용은 거의 없다(SDK 문서).
            agentProgressSummaries: true,
            // 앱은 작업마다 멈추는 버튼(백그라운드 패널의 ×·"이 작업 중지" = stopTask)을 그린다고 CLI에 알린다. 이게 있어야
            // 응답 중지(interrupt)가 백그라운드 에이전트를 살려 두고 지금 턴만 멈춘다 — 없으면 CLI가 "멈출 방법이 없는
            // 작업이 남지 않게" 에이전트까지 끈다(SDK 설명, 실측: 응답을 멈췄더니 돌던 에이전트가 "중지됨"이 됐다).
            perTaskStopAffordance: true,
            // 전체 허용 모드에서도 항상 넘긴다. 콜백이 없으면 CLI가 AskUserQuestion 도구를 아예 빼서
            // Claude가 질문 창을 띄울 수 없다(실측). 전체 허용일 때 일반 도구는 askPermission이 바로 허용한다.
            canUseTool: (toolName, toolInput, opts) =>
                askPermission(tab, toolName, toolInput as Record<string, unknown>, opts),
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
            extraArgs: buildExtraArgs(tab),
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
        tab,
        key: optionsKey(tab),
        turnActive: false,
        turnResolve: null,
        turnUuid: null,
        backgroundTasks: 0,
        bgMembers: new Map(),
        taskInfo: new Map(),
        toolInputs: new Map(),
        outputFiles: new Map(),
        idleTimer: null,
        suggestions: promptSuggestionsOn,
        waitingSuggestion: false,
        interrupting: null,
        endInterrupt: null,
        errorSent: false,
        stderrTail: "",
        stopped: false,
        ended,
    };
    tab.live = s;
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
        send(s.tab, "chat:error", notice);
    };
    try {
        for await (const msg of s.q) {
            // 중지/정리된 세션 — 프로세스가 끝날 때까지 흘려보내기만 하고 렌더러에는 아무것도 보내지 않는다
            if (s.stopped) continue;

            // 백그라운드 작업 상세용 재료(셸 명령, 출력 파일, 에이전트 도구) — 서브에이전트 메시지를 버리기 전에 모은다
            if (recordTaskArtifacts(s, msg) && s.bgMembers.size > 0) sendBackground(s);
            // 작업 파일 패널: Claude(서브에이전트 포함)가 고친 파일. 지침·기억 파일이면 지침 패널을 새로, 기억이면 알림도.
            const edited = trackFileEdits(s.tab, msg, Date.now(), (p, done) => {
                noteInstructionEdit(p);
                void noteMemorySaved(s.tab, p, done);
            });
            if (edited) sendChangedFiles(s.tab);

            // 백그라운드 작업이 끝났다 — 결과를 남긴다 (목록에서 빠지는 건 뒤따르는 background_tasks_changed)
            if (msg.type === "system" && msg.subtype === "task_notification") {
                const tn = msg as unknown as {task_id?: unknown; status?: unknown};
                if (typeof tn.task_id === "string" && (tn.status === "completed" || tn.status === "failed" || tn.status === "stopped")) {
                    s.tab.taskStatuses.set(tn.task_id, tn.status);
                }
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

            // 다음 요청 추천 — 응답이 끝난 뒤에 온다. 그새 다음 메시지를 보냈으면(같은 프로세스의 새 턴) 버린다.
            if (msg.type === "prompt_suggestion") {
                if (!s.turnActive && s.suggestions) {
                    const text = (msg as {suggestion?: unknown}).suggestion;
                    if (typeof text === "string" && text.trim()) send(s.tab, "chat:suggestion", {text: text.trim()});
                    // 기다리던 추천이 왔다 — 입력을 닫아 프로세스를 끝낸다
                    if (s.waitingSuggestion && s.backgroundTasks === 0) endInput(s);
                }
                continue;
            }

            // 백그라운드 작업이 도는 채로 응답만 멈춘 직후: 멈춘 턴에서 늦게 온 메시지는 버린다 — 안 그러면 아래에서
            // "CLI가 스스로 시작한 턴"으로 보여 새 답변처럼 떴다. 그 턴의 result가 오면 다시 받는다. 작업 목록은 계속 갱신.
            if (s.endInterrupt && !(msg.type === "system" && msg.subtype === "background_tasks_changed")) {
                if (msg.type === "result") s.endInterrupt();
                continue;
            }

            // 백그라운드 작업 완료 알림으로 CLI가 스스로 시작한 턴
            let autoTurnMessageId: string | undefined;
            if (!s.turnActive && msg.type === "assistant") {
                beginTurn(s, null, null);
                send(s.tab, "chat:turn_start");
                autoTurnMessageId = (msg as {message?: {id?: string}}).message?.id;
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
                    s.waitingSuggestion = false;
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

            handleSdkMessage(s.tab, msg, notify, () => s.stderrTail);
            // 그 턴의 첫 블록은 글자 조각이 렌더러가 턴을 열기 전에 와서 버려졌으므로 위에서 통째로 보냈다. 같은 응답의
            // 다음 블록들은 이제 조각으로 가므로 완성본에서 다시 보내지 않게 표시한다 — 안 하면 글이 두 번 찍혔다
            // (beginTurn이 이 응답의 id를 지운 탓. 생각 블록으로 시작하는 답에서 늘 생겼다).
            if (autoTurnMessageId) s.tab.streamedMessageIds.add(autoTurnMessageId);

            if (msg.type === "result") {
                commitReplaceFirst(s.tab, msg as {subtype?: string; is_error?: boolean; num_turns?: number});
                // 컨텍스트 사용량은 query가 살아 있을 때만 물을 수 있어서 턴을 닫기 직전에 조회한다
                await Promise.all([reportContextUsage(s), reportMcpStatus(s), reportCommands(s)]);
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
        s.endInterrupt?.();
        endInput(s);
        finishTurn(s);
        settlePendingPermissions(s.tab, "세션이 종료되었습니다");
        send(s.tab, "chat:background", {running: [], finished: s.tab.finishedTasks});
        if (s.tab.live === s) s.tab.live = null;
    }
}

async function sendTurn(tab: ChatTab, message: string, images: ImageData[], replaceUuid?: string): Promise<void> {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
        if (!tab.sender.isDestroyed()) tab.sender.send("claude:not_found");
        send(tab, "chat:done");
        return;
    }

    // 살아 있는 프로세스를 이어 쓸 수 없으면(입력이 닫혔거나 설정이 바뀜) 끝나길 기다렸다가 새로 띄운다.
    // 설정 변경으로 닫는 경우 백그라운드 작업도 같이 종료된다.
    const epoch = tab.stopEpoch;
    const prev = tab.live;
    // 백그라운드 작업이 도는 채로 응답만 멈춘 직후("지금 보내기" 등)면, 멈추는 중인 턴이 정리된 뒤에 보낸다 —
    // 그 전에 넣으면 CLI가 멈추는 중인 턴에 끼워 넣는다
    if (prev?.interrupting) await prev.interrupting;
    // 재생성·편집은 이어갈 지점이 바뀌므로 살아 있는 프로세스를 이어 쓸 수 없다
    if (prev && (replaceUuid || prev.inputEnded || prev.key !== optionsKey(tab))) {
        if (!prev.inputEnded) closeLive(tab);
        await prev.ended;
    }
    const resumeAt = replaceUuid ? await prepareReplace(tab, replaceUuid) : undefined;

    const content: object[] = [{type: "text", text: message}];
    for (const img of images) {
        content.push({
            type: "image",
            source: {type: "base64", media_type: img.mediaType, data: img.data},
        });
    }

    // 렌더러는 중지 즉시 턴을 닫았다. 여기서 시작하면 아무도 안 듣는 턴이 돈다.
    if (epoch !== tab.stopEpoch) {
        restoreReplaceFirst(tab);
        return;
    }

    let s: LiveSession;
    try {
        s = tab.live ?? (await startLive(tab, claudePath, resumeAt));
        if (epoch !== tab.stopEpoch) {
            closeLive(tab);
            return;
        }
    } catch (e) {
        restoreReplaceFirst(tab);
        if (epoch !== tab.stopEpoch) return;
        send(tab, "chat:error", {level: "error", message: `Claude 실행에 실패했습니다: ${(e as Error).message}`});
        send(tab, "chat:done");
        return;
    }

    return new Promise<void>((resolve) => {
        const uuid = randomUUID();
        beginTurn(s, resolve, uuid);
        // 파일 되돌리기의 기준점 — 렌더러가 이 사용자 메시지에 붙여 둔다
        send(tab, "chat:turn_uuid", {uuid});
        s.input.push({
            uuid,
            type: "user",
            message: {role: "user", content},
            parent_tool_use_id: null,
            session_id: tab.sessionId ?? "",
        } as unknown as SDKUserMessage);
    });
}

// 이 프로세스가 아는 명령 목록 — "/" 메뉴는 폴더마다 한 번 받은 목록이라, 대화 사이에 만든 스킬·터미널에서 설치한
// 플러그인이 앱을 다시 켤 때까지 메뉴에 없었다. 다음 메시지의 CLI는 그걸 읽고 뜨므로 그 응답이 끝날 때 메뉴를 바꾼다.
// (supportedCommands는 CLI가 처음·바뀔 때 알려 준 목록을 SDK가 들고 있는 것이라 CLI에 다시 묻지 않는다)
async function reportCommands(s: LiveSession) {
    try {
        const list = toCommandList(await withTimeout(s.q.supportedCommands(), 5000));
        if (!s.stopped && list.length > 0) send(s.tab, "chat:commands", list);
    } catch (e) {
        console.error("[commands] 명령 목록 조회 실패", e);
    }
}

async function reportMcpStatus(s: LiveSession) {
    try {
        const status = await withTimeout(s.q.mcpServerStatus(), 5000);
        if (!s.stopped) send(s.tab, "chat:mcp", toMcpList(status));
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
    images?: string[]; // 도구 결과에 든 그림 (data URL)
    imagesOmitted?: number; // 오래돼 싣지 않은 그림 수 (LOADED_IMAGE_BUDGET)
    startedAt?: number; // 도구를 부른 시각 — 이 도구가 만든 그림을 가려낼 때(파일 수정 시각과 비교)
}

// compact: 대화 압축(/compact 또는 컨텍스트가 차서 자동) — 앞 대화가 이 요약으로 바뀌었다
type LoadedSegment =
    | {kind: "text"; text: string}
    | {kind: "tool"; tool: LoadedTool}
    | {
          kind: "compact";
          trigger?: "manual" | "auto";
          preTokens?: number;
          postTokens?: number;
          summary?: string;
          restored?: boolean; // 기록에서 불러옴 — 그 앞 메시지는 화면에 없다(요약 속에만 있다)
      };

interface LoadedMessage {
    role: "user" | "assistant";
    content: string;
    uuid?: string;
    images?: string[];
    // "N tokens" 배지 (sessionToMessages) — 내 메시지: 그 턴의 입력 토큰, 답변: 그 턴의 출력 토큰
    inputTokens?: number;
    outputTokens?: number;
    segments?: LoadedSegment[];
    replyUuid?: string; // 답변: 그 답변의 마지막 기록 항목 — "여기까지 새 탭으로"(forkSession)의 지점
    copied?: boolean; // 갈라낸 대화로 복사된 메시지 — 파일 되돌리기 기록이 없다
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

// 압축 요약 — CLI가 앞 대화 대신 넣는 사용자 메시지(영어, CLI가 쓴 것). 라이브에서는 isSynthetic,
// 기록에서는 isCompactSummary가 붙어 온다.
const COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as {type?: string; text?: string}[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}

// 화면에 보일 요약 본문만 — 첫 안내 문장, <system-reminder>, 끝의 모델용 지시("If you need specific details…",
// "Continue the conversation…")를 뺀다. 문구가 바뀌어 못 찾으면 그 부분은 그대로 둔다.
function cleanCompactSummary(text: string): string {
    let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (t.startsWith(COMPACT_SUMMARY_PREFIX)) t = t.slice(t.indexOf("\n") >= 0 ? t.indexOf("\n") : t.length).trim();
    const tails = ["If you need specific details from before compaction", "Continue the conversation from where it left off"]
        .map((m) => t.indexOf(m))
        .filter((i) => i > 0);
    if (tails.length > 0) t = t.slice(0, Math.min(...tails)).trim();
    return t.replace(/^Summary:\s*\n/, "").trim();
}

// 라이브: isSynthetic 사용자 메시지가 이 문장으로 시작하면 요약 (사용자가 붙여 넣은 글은 isSynthetic이 아니다)
function compactSummaryText(content: unknown): string | null {
    const text = contentText(content);
    if (!text.trimStart().startsWith(COMPACT_SUMMARY_PREFIX)) return null;
    return cleanCompactSummary(text) || text.trim();
}

// 백그라운드 작업이 끝났다는 CLI의 알림(<task-notification>…). 기록에는 사용자 메시지 자리에 적히지만 사람이 쓴 글이
// 아니다 — 글이 아니라 기록의 표시(origin.kind)로 가려낸다(태그를 언급한 진짜 메시지를 먹지 않게). 실측(CLI 2.1.296~325,
// 소유자 기록 11건): 답이 끝난 뒤 온 알림은 CLI가 스스로 시작한 후속 턴의 첫 항목이고("turn" — 실시간에는 chat:turn_start로
// 새 답변이 된다), 응답 도중 끝난 작업의 알림은 도구 결과 뒤 다음 요청에 끼워진다(isQueuedCommand, "queued" — 같은 턴이
// 이어진다). subkind가 있는 것(예약 작업이 보낸 프롬프트, 다른 세션이 보낸 글 등)은 백그라운드 알림이 아니라 그대로 둔다.
function taskNotificationKind(entry: SessionMessage): "turn" | "queued" | null {
    const e = entry as {origin?: {kind?: unknown; subkind?: unknown} | null; isQueuedCommand?: unknown};
    if (e.origin?.kind !== "task-notification" || e.origin.subkind !== undefined) return null;
    return e.isQueuedCommand === true ? "queued" : "turn";
}

// 슬래시 명령 실행은 기록에 <command-name>/x</command-name><command-args>…</command-args>로 남는다
function describeCommandEntry(text: string): string | null {
    const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
    if (!name) return null;
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return args ? `${name} ${args}` : name;
}

// 다시 연 대화의 슬래시 명령 출력 (명령 항목의 uuid → 출력 글). 실시간에는 CLI가 출력을 답변(assistant)으로 보내 화면에
// 보이는데, 기록에는 system/local_command 항목으로 남고 getSessionMessages는 그걸 돌려주지 않는다(includeSystemMessages로도
// — 확인함). 그래서 다시 열면 "/context"만 남고 답이 비었다 — 기록 파일에서 직접 읽는다. 큰 기록도 있어 줄 단위로 읽고,
// 해당 줄만 JSON으로 푼다. 출력은 <local-command-stdout>, 오류는 <local-command-stderr>("Error: No messages to compact").
async function localCommandOutputs(sid: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const file = instr.findTranscript(sid);
    if (!file) return out;
    const lines = readline.createInterface({input: fs.createReadStream(file, {encoding: "utf8"}), crlfDelay: Infinity});
    for await (const line of lines) {
        if (!line.includes('"subtype":"local_command"') || !line.includes("<local-command-std")) continue;
        try {
            const e = JSON.parse(line) as {type?: string; subtype?: string; parentUuid?: string; content?: unknown};
            if (e.type !== "system" || e.subtype !== "local_command" || !e.parentUuid || typeof e.content !== "string") continue;
            const m = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(e.content);
            const text = m?.[2].trim();
            if (text) out.set(e.parentUuid, out.has(e.parentUuid) ? `${out.get(e.parentUuid)}\n${text}` : text);
        } catch {
            // 깨진 줄은 건너뛴다
        }
    }
    return out;
}

// subagent: 에이전트 자신의 기록(getSubagentMessages)을 그릴 때 — 그 기록은 항목마다 parent_tool_use_id가 붙어 있다
// commandOutputs: 다시 연 대화의 슬래시 명령 출력 (localCommandOutputs) — 명령 다음에 답변으로 넣는다
function sessionToMessages(
    entries: SessionMessage[],
    opts: {subagent?: boolean; commandOutputs?: Map<string, string>} = {}
): LoadedMessage[] {
    const out: LoadedMessage[] = [];
    let assistant: LoadedMessage | null = null;
    const tools = new Map<string, LoadedTool>();
    // 메시지의 "N tokens" 배지 — 라이브 화면은 턴이 끝날 때 result.usage(입력→내 메시지, 출력→답변)를 붙인다.
    // 기록에는 응답마다 usage가 남아 있고, 턴 안 응답들의 합이 result.usage와 같다(도구를 쓴 턴으로 확인함).
    // 기록은 한 응답을 내용 블록마다 여러 줄로 나눠 쓰고 줄마다 같은 usage가 붙어 있어 응답 id당 한 번만 센다.
    let turnUser: LoadedMessage | null = null;
    let turnTokens = {input: 0, output: 0};
    const countedIds = new Set<string>();
    // 방금 만든, 아직 요약만 든 답변 — 바로 뒤에 "/compact" 명령이 오면 명령을 그 앞에 놓는다
    let compactReply: LoadedMessage | null = null;
    // 열린 답변에 속한 마지막 기록 항목(답변·도구 결과) — 그 답변까지 갈라낼 때 쓴다
    let replyLast: string | undefined;

    const closeAssistant = () => {
        if (assistant) {
            assistant.content = (assistant.segments ?? [])
                .filter((seg): seg is {kind: "text"; text: string} => seg.kind === "text")
                .map((seg) => seg.text)
                .join("\n\n");
            if (turnTokens.output > 0) assistant.outputTokens = turnTokens.output;
            if (replyLast) assistant.replyUuid = replyLast;
            out.push(assistant);
        }
        replyLast = undefined;
        if (turnUser && turnTokens.input > 0) turnUser.inputTokens = turnTokens.input;
        assistant = null;
        turnTokens = {input: 0, output: 0};
    };

    for (const entry of entries) {
        // 서브에이전트 내부 대화는 본문에 넣지 않는다(라이브 화면과 동일) — 에이전트 패널은 따로 읽는다
        if (entry.parent_tool_use_id && !opts.subagent) continue;
        const raw = entry.message as {content?: string | ContentBlock[]} | undefined;
        const blocks: ContentBlock[] =
            typeof raw?.content === "string" ? [{type: "text", text: raw.content}] : raw?.content ?? [];

        // 대화 압축 요약. 기록은 마지막 압축부터만 오고(그 앞 메시지는 요약 속에만 있다), 요약이 사용자 메시지로
        // 적혀 있다 — "나" 말풍선이 아니라 답변 자리의 구분선으로 둔다. 자동 압축 뒤 이어진 응답은 같은 답변에 붙는다.
        // 기록에는 "/compact" 명령이 요약 뒤에 적히므로, 바로 뒤에 오면 화면에서는 명령 → 요약 순서로 바꾼다.
        if ((entry as {isCompactSummary?: boolean}).isCompactSummary) {
            closeAssistant();
            const text = contentText(raw?.content);
            assistant = {
                role: "assistant",
                content: "",
                segments: [{kind: "compact", trigger: "auto", summary: cleanCompactSummary(text) || text.trim(), restored: true}],
            };
            compactReply = assistant;
            replyLast = entry.uuid;
            continue;
        }

        if (entry.type === "assistant") {
            compactReply = null;
            if (!assistant) assistant = {role: "assistant", content: "", segments: []};
            replyLast = entry.uuid;
            const apiMessage = entry.message as {id?: string; usage?: {input_tokens?: number; output_tokens?: number}} | undefined;
            if (apiMessage?.id && apiMessage.usage && !countedIds.has(apiMessage.id)) {
                countedIds.add(apiMessage.id);
                turnTokens.input += apiMessage.usage.input_tokens ?? 0;
                turnTokens.output += apiMessage.usage.output_tokens ?? 0;
            }
            const segs = assistant.segments as LoadedSegment[];
            for (const b of blocks) {
                if (b.type === "text" && b.text) {
                    const last = segs[segs.length - 1];
                    if (last?.kind === "text") last.text += b.text;
                    else segs.push({kind: "text", text: b.text});
                } else if (b.type === "tool_use" && b.id && b.name) {
                    const at = entryTime(entry);
                    const tool: LoadedTool = {id: b.id, name: b.name, input: b.input ?? {}, status: "done", startedAt: at || undefined};
                    tools.set(b.id, tool);
                    segs.push({kind: "tool", tool});
                }
            }
            continue;
        }

        if (entry.type !== "user") continue;

        // 백그라운드 작업 완료 알림 — "나" 말풍선이 아니다(예전에는 <task-notification> XML이 그대로 내 메시지로 보였다).
        // 답이 끝난 뒤 온 것: 지금 답변을 닫고, CLI가 이어서 한 답은 새 답변으로(실시간과 같은 모양). 그 답의 입력 토큰은
        // 내 메시지 것이 아니라 아무 데도 붙이지 않는다(실시간도 후속 턴은 답변에만 붙인다). 응답 도중 끼워진 것: 같은 답변이 이어진다.
        const notification = taskNotificationKind(entry);
        if (notification) {
            compactReply = null;
            if (notification === "turn") {
                closeAssistant();
                turnUser = null;
            }
            continue;
        }

        // 도구 결과 — 앞선 도구 호출에 붙인다
        let hasToolResult = false;
        for (const b of blocks) {
            if (b.type === "tool_result" && b.tool_use_id) {
                hasToolResult = true;
                const tool = tools.get(b.tool_use_id);
                if (tool) {
                    tool.status = b.is_error ? "error" : "done";
                    tool.resultPreview = toolResultPreview(toolResultDisplayText(b.content));
                    tool.images = toolResultImages(b.content);
                }
            }
        }
        if (hasToolResult) {
            compactReply = null;
            if (assistant) replyLast = entry.uuid;
            continue;
        }

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

        const pendingCompact = compactReply;
        compactReply = null;
        if (pendingCompact && pendingCompact === assistant && /^\/compact(\s|$)/.test(content)) {
            // 요약 답변은 열어 둔 채(다음 메시지 때 닫혀 들어간다) 명령을 먼저 넣는다
            const seg = pendingCompact.segments?.[0];
            if (seg?.kind === "compact") seg.trigger = "manual";
            turnUser = {role: "user", content, uuid: entry.uuid};
            out.push(turnUser);
            continue;
        }

        closeAssistant();
        turnUser = {role: "user", content, uuid: entry.uuid, images: images.length > 0 ? images : undefined};
        out.push(turnUser);
        // 슬래시 명령의 출력 — 실시간처럼 답변으로. /compact는 구분선이 결과라 넣지 않는다(실시간에도 글은 없다)
        const output = opts.commandOutputs?.get(entry.uuid);
        if (output && !/^\/compact(\s|$)/.test(content)) assistant = {role: "assistant", content: "", segments: [{kind: "text", text: output}]};
    }
    closeAssistant();
    limitLoadedImages([...tools.values()]);
    return out;
}

// 불러온 대화에 싣는 도구 결과 그림은 최근 것부터 이만큼만 — 스크린샷을 수십 장 찍은 대화를 열 때
// 수십 MB를 한꺼번에 화면으로 보내지 않게. 넘는 것은 개수만 남긴다.
const LOADED_IMAGE_BUDGET = {tools: 40, chars: 40_000_000};

function limitLoadedImages(tools: LoadedTool[]) {
    let count = 0;
    let chars = 0;
    for (let i = tools.length - 1; i >= 0; i--) {
        const t = tools[i];
        if (!t.images) continue;
        const size = t.images.reduce((n, u) => n + u.length, 0);
        if (count < LOADED_IMAGE_BUDGET.tools && chars + size <= LOADED_IMAGE_BUDGET.chars) {
            count += 1;
            chars += size;
        } else {
            t.imagesOmitted = t.images.length;
            t.images = undefined;
        }
    }
}

function handleSdkMessage(tab: ChatTab, msg: SDKMessage, notify: (n: ChatNotice) => void, stderrTail: () => string) {
    const sid = (msg as {session_id?: string}).session_id;
    if (sid && !tab.sessionId) {
        tab.sessionId = sid;
        adoptUnsavedGrants(tab, sid);
        // 렌더러가 탭에 세션을 적어 둔다 — 탭 복원, "이미 열린 대화면 그 탭으로"
        send(tab, "chat:session", {sessionId: sid});
        // 첫 메시지 재생성·편집으로 새 세션이 생겼다. 옛 세션은 아직 지우지 않는다 — 예전에는 여기서 바로 지워서,
        // 답이 실패하면(한도 초과·오프라인) 원래 대화가 이미 사라져 있었다. 성공한 답이 오면 지운다(commitReplaceFirst).
        if (tab.replaceFirst && tab.replaceFirst.oldSid !== sid) tab.replaceFirst = {...tab.replaceFirst, newSid: sid};
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
            tab.streamedMessageIds.add(ev.message.id);
        } else if (ev.type === "content_block_delta" && ev.delta) {
            if (ev.delta.type === "text_delta" && ev.delta.text) send(tab, "chat:chunk", ev.delta.text);
            else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
                send(tab, "chat:thinking", ev.delta.thinking);
            }
        }
        return;
    }

    if (msg.type === "assistant") {
        // 스트리밍으로 이미 보낸 메시지인가. API 오류 메시지처럼 스트림 없이 오는 것도 있다.
        const streamed = !!msg.message?.id && tab.streamedMessageIds.has(msg.message.id);
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
                if (!streamed && !parentToolUseId) send(tab, "chat:chunk", block.text);
            } else if (block.type === "thinking" && block.thinking) {
                if (!streamed && !parentToolUseId) send(tab, "chat:thinking", block.thinking);
            } else if (block.type === "tool_use" && block.id && block.name) {
                send(tab, "chat:tool_use", {
                    id: block.id,
                    name: block.name,
                    input: block.input ?? {},
                    parentToolUseId,
                });
            }
        }
        // 이 답변의 마지막 기록 항목 — 스트림의 uuid가 기록 항목 uuid와 같다(확인함). "여기까지 새 탭으로"
        if (!parentToolUseId && typeof msg.uuid === "string") send(tab, "chat:reply_uuid", {uuid: msg.uuid});
        const usage = msg.message?.usage;
        // 서브에이전트의 토큰 수로 진행 표시가 덮이지 않게 본 대화 것만 보낸다
        if (usage && !parentToolUseId) {
            send(tab, "chat:usage", {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
            });
        }
        return;
    }

    if (msg.type === "user") {
        // 압축이 끝나면 CLI가 요약을 사용자 메시지로 넣는다 — 화면에는 구분선의 "요약 보기"로
        const summary = !parentToolUseId && (msg as {isSynthetic?: boolean}).isSynthetic ? compactSummaryText(msg.message?.content) : null;
        if (summary) {
            send(tab, "chat:compact", {phase: "summary", summary});
            return;
        }
        const blocks = (msg.message?.content ?? []) as {
            type: string;
            content?: string | unknown[];
            is_error?: boolean;
            tool_use_id?: string;
        }[];
        if (!Array.isArray(blocks)) return;
        const replyUuid = (msg as {uuid?: unknown}).uuid;
        if (!parentToolUseId && typeof replyUuid === "string" && blocks.some((b) => b.type === "tool_result")) {
            send(tab, "chat:reply_uuid", {uuid: replyUuid});
        }
        for (const block of blocks) {
            if (block.type === "tool_result" && block.tool_use_id) {
                send(tab, "chat:tool_result", {
                    id: block.tool_use_id,
                    isError: !!block.is_error,
                    content: toolResultPreview(toolResultDisplayText(block.content)),
                    // 서브에이전트 도구는 진행 패널에만 보이므로 그림을 싣지 않는다
                    images: parentToolUseId ? undefined : toolResultImages(block.content),
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
        send(tab, "chat:usage", {inputTokens, outputTokens});
        // 세션 누적 예상 비용과 토큰(재개한 세션은 이전 턴 포함). 청구서가 아니라 추정치.
        // 로컬 명령(/cost)·시작 오류 결과는 modelUsage가 비거나 0일 수 있다 — 그때는 토큰 누계를 덮어쓰지 않는다.
        if (typeof msg.total_cost_usd === "number") {
            const usage = totalsFromModelUsage((msg as {modelUsage?: unknown}).modelUsage);
            send(tab, "chat:cost", {totalCostUsd: msg.total_cost_usd, usage: usage ?? undefined});
            if (tab.sessionId) saveSessionStats(tab.sessionId, {cost: msg.total_cost_usd, usage: usage ?? undefined});
        }
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

    // 대화 압축: status "compacting" → status null + compact_result → compact_boundary → 요약(위 user)
    // → 이어서 원래 턴이 계속된다(자동) / 그대로 끝난다(/compact). 서브에이전트 자신의 압축은 본문과 무관하다.
    if (msg.type === "system" && msg.subtype === "status") {
        if (parentToolUseId) return;
        const st = msg as unknown as {status: string | null; compact_result?: "success" | "failed"; compact_error?: string};
        if (st.status === "compacting") send(tab, "chat:compact", {phase: "start"});
        else if (st.compact_result === "success") send(tab, "chat:compact", {phase: "done"});
        else if (st.compact_result === "failed") send(tab, "chat:compact", {phase: "failed", error: st.compact_error});
        return;
    }
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
        if (parentToolUseId) return;
        const meta = (msg as unknown as {
            compact_metadata?: {trigger?: "manual" | "auto"; pre_tokens?: number; post_tokens?: number};
        }).compact_metadata;
        send(tab, "chat:compact", {
            phase: "boundary",
            trigger: meta?.trigger,
            preTokens: meta?.pre_tokens,
            postTokens: meta?.post_tokens,
        });
        return;
    }

    if (msg.type === "system" && msg.subtype === "commands_changed") {
        const cmds = (msg as unknown as {commands: SdkSlashCommand[]}).commands ?? [];
        send(tab, "chat:commands", toCommandList(cmds));
        return;
    }

    if (msg.type === "rate_limit_event") {
        mergeRateLimits((msg as unknown as {rate_limit_info: RateLimitInfo}).rate_limit_info);
        // 요금제 사용량은 계정 전체 것이라 탭 id 없이 보낸다
        if (!tab.sender.isDestroyed()) tab.sender.send("chat:rate_limits", rateLimitList());
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

    // CLI가 띄우는 알림 줄(SDK "informational": 슬래시 명령의 알림, 훅이 막은 이유 …). 예: /goal이 오류로 목표를 지우면
    // "Goal cleared after an unrecoverable error … Run /goal again"이 이것으로만 왔다(실측) — 예전에는 버려졌다.
    // 경고·제안만 알린다('info'는 터미널에서도 기록 보기에서만, 'notice'는 흐린 회색 줄이다).
    if (msg.type === "system" && msg.subtype === "informational") {
        const inf = msg as unknown as {content?: unknown; level?: unknown};
        if (typeof inf.content === "string" && inf.content.trim() && (inf.level === "warning" || inf.level === "suggestion")) {
            notify({level: "warning", message: inf.content.trim()});
        }
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

// ── 요금제 사용량(claude.ai 구독) ──
// rate_limit_event는 바뀐 한도만 알려줄 수 있어 한도 종류별로 합쳐 둔다.
interface RateLimitWindow {
    utilization?: number; // 0~1
    resetsAt?: number; // epoch 초
    status?: string;
    receivedAt?: number; // 이 값을 받은 시각(epoch ms) — 다시 켠 뒤 보여 주는 값이 언제 것인지
}
interface RateLimitInfo extends RateLimitWindow {
    rateLimitType?: string;
    unifiedWindows?: Record<string, RateLimitWindow>;
}

const rateLimits = new Map<string, RateLimitWindow>();

function mergeRateLimits(info: RateLimitInfo | undefined) {
    if (!info) return;
    const receivedAt = Date.now();
    if (info.unifiedWindows && Object.keys(info.unifiedWindows).length > 0) {
        for (const [type, w] of Object.entries(info.unifiedWindows)) rateLimits.set(type, {...rateLimits.get(type), ...w, receivedAt});
    } else if (info.rateLimitType) {
        rateLimits.set(info.rateLimitType, {
            ...rateLimits.get(info.rateLimitType),
            utilization: info.utilization,
            resetsAt: info.resetsAt,
            status: info.status,
            receivedAt,
        });
    }
    saveRateLimits();
}

// 초기화 시각이 지난 한도는 뺀다 — 그 뒤로 새 값을 받기 전까지는 모른다
function rateLimitList() {
    const now = Date.now() / 1000;
    return [...rateLimits.entries()].filter(([, w]) => !w.resetsAt || w.resetsAt > now).map(([type, w]) => ({type, ...w}));
}

// 요금제 사용량은 응답을 받아야만 온다. 앱을 다시 켜면 첫 응답 전까지 비어 있었다 — 마지막 값을 저장해 둔다.
function rateLimitsFile(): string {
    return path.join(app.getPath("userData"), "rate-limits.json");
}

function saveRateLimits() {
    try {
        writeJsonFile(rateLimitsFile(), Object.fromEntries(rateLimits));
    } catch (e) {
        console.error("[rate-limits] 저장 실패", e);
    }
}

function loadSavedRateLimits() {
    const raw = readJsonFile<unknown>(rateLimitsFile(), {});
    if (!raw || typeof raw !== "object") return;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    for (const [type, w] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
        if (!w || typeof w !== "object") continue;
        rateLimits.set(type, {
            utilization: num(w.utilization),
            resetsAt: num(w.resetsAt),
            status: typeof w.status === "string" ? w.status : undefined,
            receivedAt: num(w.receivedAt),
        });
    }
}

function refusalDetail(category?: string | null, explanation?: string | null): string | undefined {
    const parts = [category ? `분류: ${category}` : "", explanation ?? ""].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
}

// replaceUuid: 재생성·편집일 때 대신할 사용자 메시지의 uuid
ipcMain.handle("chat:send", async (event, tabId: string, message: string, images: ImageData[] = [], replaceUuid?: string) => {
    const tab = tabFor(event, tabId);
    tab.sending++;
    try {
        await sendTurn(tab, message, images, replaceUuid);
    } finally {
        tab.sending--;
    }
});

// 방패는 기본이 "전체 허용"이고, "확인 모드"는 그 탭의 대화에서만 쓰는 임시 모드다.
// main이 대화를 비울 때(resetConversation) 전체 허용으로 되돌리고, 렌더러도 같은 때 탭 상태를 되돌린다
// (tabs:open은 결과로 돌려주고, 폴더 변경·대화 삭제는 clearedTab). 예전에는 화면만 "확인 모드"로 남아
// 묻지 않고 실행되는 일이 있었다(재현됨).
ipcMain.handle("chat:set_permissions", (event, tabId: string, allow: boolean) => {
    tabFor(event, tabId).skipPermissions = allow;
});

// 그 탭의 현재 턴과 백그라운드 작업을 모두 멈춘다. 렌더러는 이 호출과 동시에 턴을 스스로 닫으므로
// 여기서는 chat:done을 보내지 않는다 — 늦게 도착한 done이 다음 턴을 끝내 버릴 수 있다.
ipcMain.handle("chat:stop", (event, tabId: string) => {
    const tab = tabFor(event, tabId);
    const s = tab.live;
    // 백그라운드 작업이 도는 중이면 지금 응답만 멈춘다. 예전에는 프로세스를 닫아서, 작업 중에 보낸 메시지의 답을
    // 멈추면 돌던 백그라운드 작업까지 같이 꺼졌다(사용자 제보).
    if (s && !s.stopped && !s.inputEnded && hasRunningBackground(s)) {
        stopTurnOnly(tab, s);
        return;
    }
    stopEverything(tab);
});

// 백그라운드 패널의 "모두 중지" — 응답과 백그라운드 작업을 모두 멈춘다(프로세스를 닫는다)
ipcMain.handle("background:stop_all", (event, tabId: string) => stopEverything(tabFor(event, tabId)));

// 상단 "백그라운드 N" 패널: 셸 작업의 최근 출력. 렌더러는 작업 id만 넘기고, 경로는 CLI가 알려준 것만 쓴다.
// maxBytes: 끝에서 얼마나 읽을지 — 작업 줄의 마지막 한 줄은 조금, 패널의 큰 로그는 많이
ipcMain.handle("background:output", (event, tabId: string, taskId: string, maxBytes?: number) => {
    const tab = tabFor(event, tabId);
    const file = tab.live?.outputFiles.get(taskId) ?? tab.finishedOutputFiles.get(taskId);
    const bytes = typeof maxBytes === "number" && Number.isFinite(maxBytes) ? Math.min(Math.max(Math.round(maxBytes), 1000), 200_000) : 6000;
    return file ? readOutputTail(file, bytes) : null;
});

// ── 작업 파일 패널 (보고 있는 탭의 작업 폴더·고친 파일) ──
ipcMain.handle("files:changes", (event, tabId: string, p: string) => tabFor(event, tabId).changedFiles.get(p)?.hunks ?? []);
// "Claude 수정" 내역 지우기 — 목록과 표시만 비운다(파일은 그대로). 이 시각 이후에 끝난 수정부터 다시 쌓인다.
// 응답 도중이면 결과를 기다리는 수정(pendingEdits)은 남겨 둔다 — 지운 뒤에 끝나므로 새 내역이 된다(다시 계산할 때와 같다).
ipcMain.handle("files:clear_changed", (event, tabId: string) => {
    const tab = tabFor(event, tabId);
    const at = Date.now();
    tab.changedFiles.clear();
    tab.changesClearedAt = at;
    if (tab.sessionId) saveClearedAt(tab.sessionId, at);
    sendChangedFiles(tab);
});
ipcMain.handle("files:list_dir", (event, tabId: string, dir: string) => listDir(tabFor(event, tabId), dir));
ipcMain.handle("files:read", (event, tabId: string, p: string) => readFileForView(tabFor(event, tabId), p));

// ── HTML 미리보기 ──
// 코드 블록: 렌더러가 글을 넘기면 id를 준다(같은 글이면 같은 id). 파일: Claude가 만든 .html — 작업 파일 패널과 같은
// 범위(작업 폴더 안, 이 대화에서 Claude가 고친 파일)만 열고, 그 파일의 폴더를 정적 웹 파일만 내보내는 미리보기로 등록한다.
ipcMain.handle("previews:html", (_event, html: unknown) => {
    if (typeof html !== "string" || !html.trim() || html.length > MAX_PREVIEW_HTML) return null;
    return `${PREVIEW_SCHEME}://${registerHtml(html)}/`;
});

ipcMain.handle("previews:file", async (event, tabId: string, p: unknown) => {
    const tab = tabFor(event, tabId);
    if (typeof p !== "string" || !/\.html?$/i.test(p)) return {ok: false, error: "HTML 파일이 아닙니다"};
    const abs = path.isAbsolute(p) ? p : path.resolve(tab.cwd, p);
    if (!canViewPath(tab, abs)) return {ok: false, error: "이 대화의 작업 폴더 밖 파일은 미리 볼 수 없습니다"};
    try {
        const real = await fs.promises.realpath(abs);
        const st = await fs.promises.stat(real);
        if (!st.isFile()) return {ok: false, error: "파일이 아닙니다"};
        // 같은 폴더의 웹 파일(css·js·그림)도 함께 내보내되 파일 패널과 같은 범위만 — 작업 폴더 안이거나 Claude가 이 대화에서
        // 고친 파일. 폴더 밖 .html(바탕화면·/tmp)을 열면 그 폴더 아래 다른 파일까지 미리보기가 읽을 수 있었다(검토에서 찾음).
        // 고친 파일 목록은 앱이 쓰는 경로(/tmp)로 적혀 있어 실제 경로(/private/tmp)가 아니라 연 경로 기준으로 묻는다.
        const appDir = path.dirname(abs);
        const id = registerDir(path.dirname(real), tab.id, (rel) => canViewPath(tab, path.join(appDir, rel)));
        const name = path.basename(real);
        // 고친 뒤 다시 열면 새로 불러오게 수정 시각을 붙인다
        return {ok: true, src: `${PREVIEW_SCHEME}://${id}/${encodeURIComponent(name)}?v=${Math.floor(st.mtimeMs)}`, name};
    } catch {
        return {ok: false, error: "파일을 찾을 수 없습니다 — 지워졌거나 옮겨졌습니다"};
    }
});

// ── 지침 패널 (지침 | 기억) ──
// 지침 = Claude가 대화마다 읽는 CLAUDE.md 같은 파일(사람이 씀), 기억 = Claude가 스스로 적어 둔 자동 메모리.
// 파일 경로는 렌더러가 고르지 않는다: 마지막 목록(instructions:list)에 나온 파일과 기억 폴더의 .md만 읽고 쓴다.
interface CreatableInstruction {
    kind: "user" | "project" | "local";
    path: string;
    gitIgnored?: boolean | null;
}

function instructionAccess(tab: ChatTab, p: unknown): "rw" | "r" | null {
    if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0") || path.resolve(p) !== p) return null;
    if (tab.instructionReadOnly.has(p)) return "r";
    if (tab.instructionPaths.has(p)) return "rw";
    if (tab.memoryDir && path.dirname(p) === tab.memoryDir && p.endsWith(".md")) return "rw";
    return null;
}

// 작업 폴더 줄의 "지침 N" — 대화를 시작할 때 읽는 지침 파일의 토큰 합계
ipcMain.handle("instructions:summary", async (event, tabId: string) => {
    const m = await measureInstructions(tabFor(event, tabId));
    if (!m) return null;
    return {count: m.files.length, tokens: m.files.reduce((n, f) => n + f.tokens, 0)};
});

ipcMain.handle("instructions:list", async (event, tabId: string, refresh: unknown) => {
    const tab = tabFor(event, tabId);
    const cwd = tab.cwd;
    const m = await measureInstructions(tab, refresh === true);
    if (!m) return {ok: false, error: "지침 파일을 확인하지 못했습니다 — Claude CLI를 실행하지 못했습니다"};
    const files = m.files;
    const memoryFile = files.find((f) => f.type === "AutoMem");
    const memoryDir = memoryFile ? path.dirname(memoryFile.path) : null;
    const known = new Set(files.map((f) => f.path));
    const [memories, nested] = await Promise.all([
        memoryDir ? instr.listMemories(memoryDir) : Promise.resolve([]),
        tab.sessionId ? instr.nestedFromTranscript(tab.sessionId).catch(() => []) : Promise.resolve([]),
    ]);
    const nestedNew = nested.filter((n) => !known.has(n.path));
    // 아직 없는 지침 — 만들 자리를 알려 준다 (지워진 작업 폴더에는 만들지 않는다)
    const creatable: CreatableInstruction[] = [];
    if (!files.some((f) => f.type === "User")) creatable.push({kind: "user", path: path.join(instr.claudeConfigDir(), "CLAUDE.md")});
    if (fs.existsSync(cwd)) {
        if (!files.some((f) => f.type === "Project" && path.basename(f.path) === "CLAUDE.md")) {
            creatable.push({kind: "project", path: path.join(cwd, "CLAUDE.md")});
        }
        if (!files.some((f) => f.type === "Local")) {
            creatable.push({kind: "local", path: path.join(cwd, "CLAUDE.local.md"), gitIgnored: await isGitIgnored(cwd, "CLAUDE.local.md")});
        }
    }
    tab.instructionPaths = new Set([...known, ...nestedNew.map((n) => n.path), ...memories.map((x) => x.path), ...creatable.map((c) => c.path)]);
    tab.instructionReadOnly = new Set(files.filter((f) => f.type === "Managed").map((f) => f.path));
    tab.memoryDir = memoryDir;
    return {ok: true, cwd, files, startTotal: m.startTotal, maxTokens: m.maxTokens, measuredAt: m.at, nested: nestedNew, memoryDir, memories, creatable};
});

ipcMain.handle("instructions:read", async (event, tabId: string, p: unknown) => {
    const tab = tabFor(event, tabId);
    const access = instructionAccess(tab, p);
    if (!access) return {ok: false, error: "지침 패널에서 열 수 있는 파일이 아닙니다"};
    const file = p as string;
    try {
        const st = await fs.promises.stat(file);
        if (!st.isFile()) return {ok: false, error: "파일이 아닙니다"};
        if (st.size > instr.MAX_INSTRUCTION_BYTES) return {ok: false, error: "파일이 너무 큽니다 (2MB 넘음)"};
        return {ok: true, exists: true, content: await fs.promises.readFile(file, "utf8"), mtimeMs: st.mtimeMs, readOnly: access === "r"};
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {ok: true, exists: false, content: "", mtimeMs: null, readOnly: access === "r"};
        return {ok: false, error: (e as Error).message};
    }
});

// 저장 — 연 뒤에 다른 곳(Claude·편집기)에서 바뀌었으면(수정 시각이 다르면) 덮어쓰지 않고 conflict로 알린다.
// force = 그래도 덮어쓰기. 고친 내용은 다음 메시지부터 적용된다(CLI가 바뀐 지침 파일을 다음 요청에 다시 넣는다 — 실측).
ipcMain.handle("instructions:write", async (event, tabId: string, p: unknown, content: unknown, baseMtime: unknown, force: unknown) => {
    const tab = tabFor(event, tabId);
    if (instructionAccess(tab, p) !== "rw") return {ok: false, error: "고칠 수 없는 파일입니다"};
    if (typeof content !== "string" || Buffer.byteLength(content) > instr.MAX_INSTRUCTION_BYTES) {
        return {ok: false, error: "내용이 너무 큽니다 (2MB 넘음)"};
    }
    const file = p as string;
    let current: number | null = null;
    try {
        current = (await fs.promises.stat(file)).mtimeMs;
    } catch {
        current = null;
    }
    if (force !== true && current !== (typeof baseMtime === "number" ? baseMtime : null)) {
        return {ok: false, conflict: true, exists: current !== null};
    }
    if (!fs.existsSync(path.dirname(file))) return {ok: false, error: "파일을 만들 폴더가 없습니다"};
    try {
        const mtimeMs = await instr.writeFileAtomic(file, content);
        invalidateInstructions();
        return {ok: true, mtimeMs};
    } catch (e) {
        return {ok: false, error: (e as Error).message};
    }
});

// 기억 지우기 — 파일과 MEMORY.md 목록의 그 줄을 함께 지운다
ipcMain.handle("instructions:delete_memory", async (event, tabId: string, p: unknown) => {
    const tab = tabFor(event, tabId);
    const dir = tab.memoryDir;
    if (!dir || typeof p !== "string" || path.dirname(p) !== dir || !p.endsWith(".md") || path.basename(p) === "MEMORY.md") {
        return {ok: false, error: "지울 수 있는 기억이 아닙니다"};
    }
    try {
        await fs.promises.rm(p, {force: true});
        await instr.removeFromIndex(dir, path.basename(p));
        invalidateInstructions();
        return {ok: true};
    } catch (e) {
        return {ok: false, error: (e as Error).message};
    }
});

// ── 확장 창: 플러그인 (claude plugin …) ──
// SDK에 설치·지우기 API가 없어 앱이 고른 claude로 셸 명령을 돌린다(services/plugins.ts). 설정은 터미널의 claude와 같은 곳에 적힌다.
// 바꾸는 명령(설치·켜기·끄기·지우기)은 앱 전체에서 한 번에 하나만 — 두 명령이 같은 설정 파일을 동시에 고치지 않게.
const PLUGIN_TIMEOUT = {list: 30_000, available: 90_000, details: 30_000, install: 300_000, toggle: 60_000, uninstall: 120_000};
const PLUGIN_CACHE_MS = 10 * 60_000;

type PluginOpKind = "install" | "enable" | "disable" | "uninstall";
let pluginOp: {kind: PluginOpKind; id: string; startedAt: number; cancel: () => void} | null = null;
const pluginDetailsCache = new Map<string, {at: number; p: Promise<plug.PluginDetails | {error: string}>}>();
const pluginAvailableCache = new Map<string, {at: number; p: Promise<AvailablePluginsResult>}>();

type AvailablePluginsResult =
    | {
          ok: true;
          plugins: {
              id: string;
              name: string;
              description?: string;
              marketplace: string;
              version?: string;
              installCount: number | null;
              source: plug.PluginSource;
          }[];
          installed: string[];
          fetchedAt: number;
      }
    | {ok: false; error: string};

// CLI가 실행될 폴더 — 레포 범위(프로젝트·나만) 설정은 이 폴더의 레포에 적힌다. 지워진 폴더면 홈(사용자 범위만 안전하다).
function pluginCwd(tab: ChatTab): string {
    try {
        if (fs.statSync(tab.cwd).isDirectory()) return tab.cwd;
    } catch {
        // 아래
    }
    return os.homedir();
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

// CLI가 실패했을 때 보일 한국어 — 결과 JSON이 없으면(충돌·시간 초과) stderr의 마지막 줄
function pluginCliError(r: plug.PluginCliResult, what: string): string {
    if (r.spawnError) return `Claude CLI를 실행하지 못했습니다: ${r.spawnError}`;
    if (r.timedOut) return `${what} — 시간이 너무 오래 걸려 멈췄습니다`;
    if (r.cancelled) return "취소했습니다";
    const last = r.stderr.trim().split("\n").filter(Boolean).pop();
    return last ? `${what}: ${last.replace(/^✘\s*/, "")}` : `${what} (종료 코드 ${r.code ?? "?"})`;
}

// CLI가 사람에게 보이는 글 — stdout의 결과 JSON 줄 앞 글(명령 실행형 설치의 안내·거절 이유는 여기 온다)과 stderr
function pluginCliText(r: plug.PluginCliResult): string | undefined {
    const out = r.stdout.split("\n").filter((l) => l.trim() && !l.trim().startsWith("{"));
    const err = r.stderr.split("\n").filter((l) => l.trim() && !out.includes(l));
    const text = [...out, ...err].join("\n").trim();
    return text ? text.slice(-2000) : undefined;
}

const PLUGIN_FAILURES: Record<string, string> = {
    not_found: "마켓플레이스에서 이 플러그인을 찾지 못했습니다 — 마켓플레이스 목록이 오래됐을 수 있습니다 (터미널: claude plugin marketplace update)",
    enabled_at_project_scope:
        "팀 공유 설정(레포의 .claude/settings.json)에서 켜져 있어 이 범위로는 지울 수 없습니다 — \"팀 공유\" 범위로 지우거나, 나만 끄려면 끄기에서 \"이 레포에서 나만\"을 고르세요",
    invalid_plugin_id: "플러그인 이름이 올바르지 않습니다",
};

const SCOPE_WORD: Record<string, string> = {user: "모든 프로젝트", project: "팀 공유(레포 설정)", local: "이 레포에서 나만"};

// 플러그인이 바뀐 뒤: 캐시를 비우고, 폴더 정보("/" 메뉴의 명령·MCP 목록)와 지침·대화 시작 비용(플러그인 스킬이 시작 컨텍스트에
// 든다)을 다시 받게 한다. 살아 있는 CLI(응답 중·추천 대기·백그라운드 작업)는 플러그인을 다시 읽힌다(reloadPlugins — 같은 프로세스로
// 갈 다음 메시지에도 적용되게). 다시 읽기는 마켓플레이스를 맞춰 보느라 네트워크를 기다릴 수 있어(답하지 않는 저장소가 있으면 끝없이
// 기다렸다 — 실측) 기다리지 않고 뒤에서 하고, 끝나면 그 탭의 명령·MCP 목록을 보낸다.
function afterPluginChange() {
    pluginDetailsCache.clear();
    pluginAvailableCache.clear();
    invalidateInstructions();
    folderInfo.clear();
    for (const tab of tabs.values()) {
        const s = tab.live;
        if (!s || s.stopped || s.inputEnded) {
            pushFolderInfo(tab);
            continue;
        }
        void withTimeout(s.q.reloadPlugins(), 60_000)
            .then((r) => {
                if (s.stopped || tab.live !== s) return;
                send(tab, "chat:commands", toCommandList(r.commands));
                send(tab, "chat:mcp", toMcpList(r.mcpServers));
            })
            .catch((e) => console.error("[plugins] 살아 있는 세션의 플러그인 다시 읽기 실패", (e as Error)?.message));
    }
}

// 설치된 플러그인 — 이 폴더에서 쓰는 것(here: 사용자 범위, 또는 이 폴더가 그 레포 안)과 다른 레포에만 있는 것
ipcMain.handle("plugins:list", async (event, tabId: string) => {
    const tab = tabFor(event, tabId);
    const claudePath = resolveClaudePath();
    if (!claudePath) return {ok: false, error: "Claude CLI를 찾지 못했습니다"};
    const cwd = pluginCwd(tab);
    const r = await plug.runPluginCli(claudePath, ["list", "--json"], cwd, PLUGIN_TIMEOUT.list).result;
    const data = plug.parseCliJson(r.stdout);
    if (!Array.isArray(data)) return {ok: false, error: pluginCliError(r, "설치된 플러그인 목록을 받지 못했습니다")};
    const realCwd = realOrResolved(cwd);
    const plugins = data.filter(isRecord).flatMap((p) => {
        const id = typeof p.id === "string" ? p.id : "";
        if (!id) return [];
        const {name, marketplace} = plug.splitPluginId(id);
        const scope = typeof p.scope === "string" ? p.scope : "user";
        const projectPath = typeof p.projectPath === "string" ? p.projectPath : undefined;
        const here = scope === "user" || scope === "managed" || (!!projectPath && isInside(realOrResolved(projectPath), realCwd));
        const servers = isRecord(p.mcpServers) ? p.mcpServers : {};
        return [
            {
                id,
                name,
                marketplace,
                version: typeof p.version === "string" ? p.version : undefined,
                scope,
                enabled: p.enabled === true,
                here,
                projectPath,
                installedAt: typeof p.installedAt === "string" ? p.installedAt : undefined,
                mcpServers: Object.entries(servers).map(([server, cfg]) => {
                    const c = isRecord(cfg) ? cfg : {};
                    const command = typeof c.command === "string" ? c.command : "";
                    const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string") : [];
                    return {
                        name: server,
                        transport: typeof c.type === "string" ? c.type : command ? "stdio" : "unknown",
                        target: typeof c.url === "string" ? c.url : [command, ...args].join(" ").trim() || undefined,
                    };
                }),
            },
        ];
    });
    return {ok: true, cwd: tab.cwd, projectRoot: plug.projectRootFor(cwd), home: os.homedir(), configDir: instr.claudeConfigDir(), plugins};
});

// 플러그인 하나에 든 것(스킬·에이전트·훅·MCP)과 대화마다 드는 토큰 — claude plugin details (설치된 것만 된다)
ipcMain.handle("plugins:details", async (event, tabId: string, id: unknown) => {
    if (!plug.isPluginRef(id)) return {ok: false, error: "플러그인 이름이 올바르지 않습니다"};
    const tab = tabFor(event, tabId);
    const claudePath = resolveClaudePath();
    if (!claudePath) return {ok: false, error: "Claude CLI를 찾지 못했습니다"};
    const cwd = pluginCwd(tab);
    const key = `${cwd}\u0000${id}`;
    let hit = pluginDetailsCache.get(key);
    if (!hit || Date.now() - hit.at > PLUGIN_CACHE_MS) {
        const p = plug
            .runPluginCli(claudePath, ["details", id], cwd, PLUGIN_TIMEOUT.details)
            .result.then((r) => plug.parsePluginDetails(r.stdout) ?? {error: pluginCliError(r, "플러그인 내용을 읽지 못했습니다")});
        hit = {at: Date.now(), p};
        pluginDetailsCache.set(key, hit);
        void p.then((d) => {
            if ("error" in d && pluginDetailsCache.get(key) === hit) pluginDetailsCache.delete(key);
        });
    }
    const d = await hit.p;
    return "error" in d ? {ok: false, error: d.error} : {ok: true, details: d};
});

// 설치할 수 있는 플러그인 — 등록된 마켓플레이스와 공식 디렉터리(4천여 개). 출처 링크를 만들려고 마켓플레이스 목록도 받는다.
ipcMain.handle("plugins:available", async (event, tabId: string, refresh: unknown): Promise<AvailablePluginsResult> => {
    const tab = tabFor(event, tabId);
    const claudePath = resolveClaudePath();
    if (!claudePath) return {ok: false, error: "Claude CLI를 찾지 못했습니다"};
    const cwd = pluginCwd(tab);
    const cached = pluginAvailableCache.get(cwd);
    if (cached && refresh !== true && Date.now() - cached.at < PLUGIN_CACHE_MS) return cached.p;
    const p = (async (): Promise<AvailablePluginsResult> => {
        const [r, m] = await Promise.all([
            plug.runPluginCli(claudePath, ["list", "--json", "--available"], cwd, PLUGIN_TIMEOUT.available).result,
            plug.runPluginCli(claudePath, ["marketplace", "list", "--json"], cwd, PLUGIN_TIMEOUT.list).result,
        ]);
        const data = plug.parseCliJson(r.stdout);
        if (!isRecord(data) || !Array.isArray(data.available)) {
            return {ok: false, error: pluginCliError(r, "설치할 수 있는 플러그인 목록을 받지 못했습니다")};
        }
        const markets = plug.parseCliJson(m.stdout);
        const byName = new Map<string, plug.MarketplaceInfo>(
            (Array.isArray(markets) ? markets : []).filter(isRecord).map((x) => [String(x.name), x as unknown as plug.MarketplaceInfo])
        );
        const plugins = data.available.filter(isRecord).flatMap((x) => {
            const id = typeof x.pluginId === "string" ? x.pluginId : "";
            if (!id) return [];
            const marketplace = typeof x.marketplaceName === "string" ? x.marketplaceName : plug.splitPluginId(id).marketplace;
            return [
                {
                    id,
                    name: typeof x.name === "string" ? x.name : plug.splitPluginId(id).name,
                    description: typeof x.description === "string" && x.description.trim() ? x.description.trim() : undefined,
                    marketplace,
                    version: typeof x.version === "string" ? x.version : undefined,
                    installCount: typeof x.installCount === "number" ? x.installCount : null,
                    source: plug.describePluginSource(x.source, byName.get(marketplace)),
                },
            ];
        });
        const installed = (Array.isArray(data.installed) ? data.installed : []).filter(isRecord).map((x) => String(x.id ?? ""));
        return {ok: true, plugins, installed: installed.filter(Boolean), fetchedAt: Date.now()};
    })().catch((e) => ({ok: false as const, error: `설치할 수 있는 플러그인 목록을 받지 못했습니다: ${(e as Error).message}`}));
    const entry = {at: Date.now(), p};
    pluginAvailableCache.set(cwd, entry);
    void p.then((res) => {
        if (!res.ok && pluginAvailableCache.get(cwd) === entry) pluginAvailableCache.delete(cwd);
    });
    return p;
});

// 설치·켜기·끄기·지우기. 명령 실행형 설치는 처음에 CLI가 명령을 보이고 거절한다 → confirm으로 그 명령을 화면에 보이고,
// 사람이 확인하면 acceptCommand(그 sha256)를 실어 다시 부른다. 같은 명령·같은 카탈로그일 때만 CLI가 받는다.
ipcMain.handle("plugins:run", async (event, tabId: string, op: unknown) => {
    const tab = tabFor(event, tabId);
    if (pluginOp) return {ok: false, busy: true, error: "다른 플러그인 작업이 진행 중입니다 — 끝난 뒤 다시 하세요"};
    const o = isRecord(op) ? op : {};
    const kind = o.kind;
    const id = o.id;
    if (kind !== "install" && kind !== "enable" && kind !== "disable" && kind !== "uninstall") return {ok: false, error: "알 수 없는 작업입니다"};
    if (!plug.isPluginRef(id)) return {ok: false, error: "플러그인 이름이 올바르지 않습니다"};
    const scope = o.scope;
    if (kind !== "enable" && !plug.isPluginScope(scope)) return {ok: false, error: "범위가 올바르지 않습니다"};
    const accept = typeof o.acceptCommand === "string" ? o.acceptCommand : undefined;
    if (o.acceptCommand !== undefined && (!accept || !/^[0-9a-f]{64}$/.test(accept))) return {ok: false, error: "확인한 명령이 올바르지 않습니다"};
    const claudePath = resolveClaudePath();
    if (!claudePath) return {ok: false, error: "Claude CLI를 찾지 못했습니다"};
    const cwd = tab.cwd;
    if (!fs.existsSync(cwd)) return {ok: false, error: "작업 폴더가 없습니다 — 폴더를 바꾼 뒤 다시 하세요"};
    // 홈 폴더(레포 아님)의 "프로젝트 설정"은 ~/.claude/settings.json — 사용자 설정과 같은 파일이라 레포 범위로는 쓰지 않는다
    if ((scope === "project" || scope === "local") && realOrResolved(plug.projectRootFor(cwd)) === realOrResolved(os.homedir())) {
        return {ok: false, error: "홈 폴더는 레포가 아니라 레포 범위로 바꿀 수 없습니다 — \"모든 프로젝트\"로 하거나, 레포 폴더의 탭에서 하세요"};
    }
    const args =
        kind === "install"
            ? ["install", id, "--scope", scope as string, "--json", ...(accept ? ["--accept-command", accept] : [])]
            : kind === "enable"
              ? ["enable", id, "--json"]
              : [kind, id, "--scope", scope as string, "--json"];
    const timeout = kind === "install" ? PLUGIN_TIMEOUT.install : kind === "uninstall" ? PLUGIN_TIMEOUT.uninstall : PLUGIN_TIMEOUT.toggle;
    const handle = plug.runPluginCli(claudePath, args, cwd, timeout);
    pluginOp = {kind, id, startedAt: Date.now(), cancel: handle.cancel};
    let r: plug.PluginCliResult;
    try {
        r = await handle.result;
    } finally {
        pluginOp = null;
    }
    const json = plug.parseCliJson(r.stdout);
    const res = isRecord(json) ? json : null;
    const name = plug.splitPluginId(id).name;
    if (r.cancelled || r.timedOut) {
        afterPluginChange();
        return {
            ok: false,
            cancelled: r.cancelled,
            error: r.cancelled
                ? "취소했습니다 — 도중에 멈춰서 일부만 바뀌었을 수 있습니다. 목록을 다시 확인하세요"
                : `시간이 너무 오래 걸려 멈췄습니다 (${timeout >= 60_000 ? `${Math.round(timeout / 60_000)}분` : `${Math.round(timeout / 1000)}초`}) — 네트워크가 느리거나 저장소가 큽니다. 목록을 다시 확인하세요`,
        };
    }
    if (res?.outcome === "ok") {
        afterPluginChange();
        const where = SCOPE_WORD[String(res.scope ?? scope)] ?? "";
        const message =
            kind === "install"
                ? `${name} 설치함${where ? ` — ${where}` : ""}`
                : kind === "enable"
                  ? `${name} 켬`
                  : kind === "disable"
                    ? `${name} 끔${where ? ` — ${where}` : ""}`
                    : `${name} 지움${where ? ` — ${where}` : ""}`;
        return {ok: true, message, cliMessage: typeof res.message === "string" ? res.message : undefined};
    }
    const code = typeof res?.failureCode === "string" ? res.failureCode : undefined;
    if (code === "already_in_goal_state") {
        return {ok: true, message: kind === "enable" ? `${name}은(는) 이미 켜져 있습니다` : kind === "disable" ? `${name}은(는) 이미 꺼져 있습니다` : `${name}: 이미 그 상태입니다`};
    }
    const shown = isRecord(res?.shownCommand) ? res?.shownCommand : null;
    if (code === "command_source_refused" && shown && typeof shown.sha256 === "string") {
        // 확인하고 다시 보냈는데도 거절 — CLI가 받지 않는 환경(예: Claude Code 세션 안에서 띄운 앱)이거나 그사이 명령이 바뀌었다
        if (accept) {
            const changed = shown.sha256 !== accept;
            const text = pluginCliText(r);
            return {
                ok: false,
                code,
                error: changed
                    ? "그사이 마켓플레이스의 설치 명령이 바뀌었습니다 — 새 명령을 다시 확인하세요"
                    : /inside a Claude Code session/i.test(text ?? "")
                      ? `Claude Code 안에서 띄운 앱이라 CLI가 확인을 받지 않습니다 — 터미널에서 claude plugin install ${id}로 설치하세요`
                      : `CLI가 확인한 명령을 받지 않았습니다 — 터미널에서 claude plugin install ${id}로 설치하세요`,
                detail: text,
                confirm: changed ? {command: String(shown.command ?? ""), mode: typeof shown.mode === "string" ? shown.mode : undefined, sha256: shown.sha256} : undefined,
            };
        }
        return {
            ok: false,
            code,
            error: "이 플러그인은 마켓플레이스가 정한 명령을 이 컴퓨터에서 실행해 설치합니다 — 명령을 확인해 주세요",
            confirm: {command: String(shown.command ?? ""), mode: typeof shown.mode === "string" ? shown.mode : undefined, sha256: shown.sha256},
        };
    }
    const cliMessage = typeof res?.message === "string" ? res.message : undefined;
    return {
        ok: false,
        code,
        error: (code && PLUGIN_FAILURES[code]) || (cliMessage ? `실패했습니다: ${cliMessage}` : pluginCliError(r, "플러그인 명령이 실패했습니다")),
        detail: code && PLUGIN_FAILURES[code] ? cliMessage : pluginCliText(r),
    };
});

// 진행 중인 바꾸는 명령 — 창을 닫았다 다시 열었을 때 "설치 중"을 이어 보여 준다 / 취소(설치가 오래 걸릴 때)
ipcMain.handle("plugins:busy", () => (pluginOp ? {kind: pluginOp.kind, id: pluginOp.id, startedAt: pluginOp.startedAt} : null));
ipcMain.handle("plugins:cancel", () => {
    pluginOp?.cancel();
});

// ── 답변 속 그림 ──
// 화면이 답변 글·도구 입출력에서 찾은 그림 경로를 확인해 썸네일을 준다. since가 있으면 그 뒤에 바뀐 파일만
// (Bash 명령에 나온 그림 중 그 명령이 만든 것만 — 이미 있던 그림을 ls로 훑은 것까지 띄우지 않게).
// infoOnly는 경로만 확인한다(같은 그림을 한 답변에 두 번 띄우지 않으려고).
interface ImageRefReq {
    ref: string;
    since?: number;
    infoOnly?: boolean;
}

const MAX_IMAGE_REFS = 24;
const MAX_TAB_IMAGE_PATHS = 500;

function rememberImagePath(tab: ChatTab, p: string) {
    tab.imagePaths.delete(p);
    tab.imagePaths.add(p);
    if (tab.imagePaths.size > MAX_TAB_IMAGE_PATHS) {
        const oldest = tab.imagePaths.values().next().value;
        if (oldest !== undefined) tab.imagePaths.delete(oldest);
    }
}

ipcMain.handle("images:resolve", async (event, tabId: string, refs: unknown) => {
    const tab = tabFor(event, tabId);
    const list = Array.isArray(refs) ? (refs as ImageRefReq[]).slice(0, MAX_IMAGE_REFS) : [];
    return Promise.all(
        list.map(async (r) => {
            const ref = String(r?.ref ?? "");
            const since = typeof r?.since === "number" ? r.since : undefined;
            const infoOnly = !!r?.infoOnly;
            const fail = {ref, since, infoOnly, ok: false as const};
            const loc = parseFileRef(tab, ref);
            const img = loc ? await imageFile(loc.abs) : null;
            if (!img || (since !== undefined && img.mtime < since)) return fail;
            rememberImagePath(tab, img.path);
            const base = {ref, since, infoOnly, ok: true as const, path: img.path, name: path.basename(img.path), size: img.size};
            if (infoOnly) return base;
            const thumb = await imageThumbnail(img).catch(() => null);
            return thumb ? {...base, thumb: thumb.url, full: thumb.full} : base;
        })
    );
});

// 원본 그림 (확대 창, 작업 파일 패널) — 답변에서 확인해 준 그림이나 작업 파일 패널에서 볼 수 있는 파일만
ipcMain.handle("images:read", async (event, tabId: string, p: unknown): Promise<string | null> => {
    const tab = tabFor(event, tabId);
    if (typeof p !== "string" || !path.isAbsolute(p)) return null;
    if (!tab.imagePaths.has(p) && !canViewPath(tab, p)) return null;
    const img = await imageFile(p);
    return img ? imageDataUrl(img).catch(() => null) : null;
});
// 작업 폴더 안·Claude가 고친 파일, 그리고 이 탭의 답변에 나온 그림(크게 보기의 "Finder에서 보기")만
ipcMain.handle("files:reveal", (event, tabId: string, p: string) => {
    const tab = tabFor(event, tabId);
    if (typeof p !== "string" || !path.isAbsolute(p)) return;
    if ((tab.imagePaths.has(p) || canViewPath(tab, p)) && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ── 파일을 JetBrains IDE로 열기 (src/main/services/jetbrains.ts) ──
// 답변 속 경로는 작업 폴더 기준 상대 경로이거나 절대 경로다. 끝의 ":줄(:칸)"·"#L줄"은 떼어 줄 번호로 쓴다.
// 있는 파일만 연다(폴더·없는 경로는 아니다). IDE에 보여 주기만 하고 실행하지는 않는다.
type EditorResult =
    | {ok: true; app: string; path: string; line?: number}
    | {ok: false; reason: "not-found" | "no-ide" | "error"; message?: string};

function parseFileRef(tab: ChatTab, raw: string): {abs: string; line?: number} | null {
    let s = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "");
    if (s.startsWith("file://")) {
        try {
            s = new URL(s).pathname;
        } catch {
            return null;
        }
    }
    if (s.includes("%")) {
        try {
            s = decodeURIComponent(s);
        } catch {
            // 그대로 쓴다
        }
    }
    let line: number | undefined;
    const hash = /#L?(\d+)(?:-L?\d+)?$/.exec(s);
    const colon = hash ? null : /:(\d+)(?::\d+)?(?:-\d+)?$/.exec(s);
    const lineMatch = hash ?? colon;
    if (lineMatch) {
        line = Number(lineMatch[1]);
        s = s.slice(0, lineMatch.index);
    }
    if (!s) return null;
    if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
    const abs = path.isAbsolute(s) ? path.normalize(s) : path.resolve(tab.cwd, s);
    try {
        if (!fs.statSync(abs).isFile()) return null;
    } catch {
        return null;
    }
    return {abs, line: line && line > 0 ? line : undefined};
}

function editorTarget(tab: ChatTab, raw: unknown): EditorResult & {ide?: ReturnType<typeof pickIde>} {
    const ref = parseFileRef(tab, String(raw ?? ""));
    if (!ref) return {ok: false, reason: "not-found"};
    const ide = pickIde(ref.abs);
    if (!ide) return {ok: false, reason: "no-ide"};
    return {ok: true, app: ide.name, path: ref.abs, line: ref.line, ide};
}

ipcMain.handle("editor:resolve", (event, tabId: string, raw: string): EditorResult => {
    const target = editorTarget(tabFor(event, tabId), raw);
    // IDE 실행 경로는 화면에 넘기지 않는다
    delete target.ide;
    return target;
});

ipcMain.handle("editor:open", async (event, tabId: string, raw: string): Promise<EditorResult> => {
    const {ide, ...target} = editorTarget(tabFor(event, tabId), raw);
    if (!target.ok || !ide) return target;
    try {
        await openInIde(ide, target.path, target.line);
        return target;
    } catch (e) {
        return {ok: false, reason: "error", message: (e as Error).message};
    }
});

// ── 작업 파일 패널의 "Git 변경" 보기 ──
// 마지막 결과를 들고 있다가, 차이를 요청받으면 그 목록에 있는 파일인지 확인한다 — 렌더러가 보낸 경로로
// 아무 파일이나 git에 넘기지 않게. 같은 폴더의 요청이 겹치면 진행 중인 것을 같이 쓴다.
function refreshGitStatus(tab: ChatTab): Promise<GitStatusResult> {
    const cwd = tab.cwd;
    if (tab.gitInFlight && tab.gitInFlight.cwd === cwd) return tab.gitInFlight.promise;
    const promise: Promise<GitStatusResult> = getGitStatus(cwd, (abs) => toCwdPath(cwd, abs))
        .catch((e): GitStatusResult => ({ok: false, reason: "error", message: (e as Error).message}))
        .then((res) => {
            if (cwd === tab.cwd) {
                tab.lastGit = res.ok
                    ? {cwd, root: res.root, initial: res.branch.initial, byPath: new Map(res.files.map((f) => [f.path, f]))}
                    : null;
            }
            return res;
        })
        .finally(() => {
            if (tab.gitInFlight?.promise === promise) tab.gitInFlight = null;
        });
    tab.gitInFlight = {cwd, promise};
    return promise;
}

ipcMain.handle("git:status", (event, tabId: string) => refreshGitStatus(tabFor(event, tabId)));
ipcMain.handle("git:diff", async (event, tabId: string, p: unknown) => {
    if (typeof p !== "string") return {error: "잘못된 경로입니다"};
    const tab = tabFor(event, tabId);
    const lookup = () => (tab.lastGit && tab.lastGit.cwd === tab.cwd ? tab.lastGit.byPath.get(p) : undefined);
    let entry = lookup();
    // 목록이 그사이 바뀌었을 수 있다 — 한 번 새로 읽어 본다
    if (!entry) {
        await refreshGitStatus(tab);
        entry = lookup();
    }
    const git = tab.lastGit;
    if (!entry || !git) return {error: "Git 변경 목록에 없는 파일입니다"};
    return getGitDiff(git.root, entry, git.initial);
});

// "최근 끝난 작업" 기록 지우기
ipcMain.handle("background:clear_finished", (event, tabId: string) => {
    const tab = tabFor(event, tabId);
    tab.finishedTasks = [];
    tab.finishedOutputFiles.clear();
    const s = tab.live;
    if (s) sendBackground(s);
    else send(tab, "chat:background", {running: [], finished: []});
});

// 백그라운드 작업 하나만 멈춘다
ipcMain.handle("background:stop", async (event, tabId: string, taskId: string) => {
    const s = tabFor(event, tabId).live;
    if (!s) return;
    try {
        await withTimeout(s.q.stopTask(taskId), 5000);
    } catch (e) {
        console.error("[background] 작업 중지 실패", e);
    }
});

ipcMain.handle("chat:question_response", (_event, id: string, answers: string[][]) => {
    const pending = pendingPermissions.get(id);
    if (!pending) return;
    pendingPermissions.delete(id);
    const questions = pendingQuestions.get(id) ?? [];
    pendingQuestions.delete(id);
    // 답을 되돌릴 자리가 프로토콜상 deny의 message뿐이다. 실측 결과 이 문자열이
    // 그대로 tool_result가 되고 모델이 정상적으로 이어받는다.
    pending.settle({behavior: "deny", message: formatQuestionAnswers(questions, answers)});
});

ipcMain.handle("chat:permission_response", (_event, id: string, allow: boolean, always = false) => {
    const pending = pendingPermissions.get(id);
    if (!pending) return;
    pendingPermissions.delete(id);
    const updates = pendingSuggestions.get(id) ?? [];
    pendingSuggestions.delete(id);
    if (!allow) {
        pending.settle({behavior: "deny", message: "사용자가 거부했습니다"});
        return;
    }
    if (always && updates.length > 0) {
        // 지금 프로세스에는 updatedPermissions로, 다음 프로세스에는 allowedTools로 전달된다
        rememberSessionUpdates(pending.tab, updates);
        pending.settle({behavior: "allow", updatedPermissions: updates});
        return;
    }
    pending.settle({behavior: "allow"});
});

// 탭의 대화를 비우고 새 대화로 — 열어 둔 CLI 프로세스(백그라운드 작업 포함)는 닫는다
function resetConversation(tab: ChatTab) {
    closeLive(tab);
    tab.replaceFirst = null;
    clearFinishedTasks(tab);
    tab.taskStatuses.clear();
    resetChangedFiles(tab);
    sendChangedFiles(tab);
    tab.unsavedGrants = emptyGrants();
    tab.sessionId = null;
    tab.skipPermissions = true; // 새 대화는 전체 허용으로 시작 — 렌더러도 같은 때 탭 상태를 되돌린다
}

// 채팅 설정은 탭마다 따로 있고, 바꾼 값은 다음 새 탭의 기본값이 된다(설정 파일에도 저장)
ipcMain.handle("chat:set_model", (event, tabId: string, model: string) => {
    tabFor(event, tabId).model = model;
    defaults.model = model;
    settings.save({model});
});
ipcMain.handle("chat:set_effort", (event, tabId: string, effort: string) => {
    tabFor(event, tabId).effort = effort;
    defaults.effort = effort;
    settings.save({effort});
});

ipcMain.handle("chat:set_ultracode", (event, tabId: string, on: boolean) => {
    tabFor(event, tabId).ultracode = on;
    defaults.ultracode = on;
    settings.save({ultracode: on});
});

// 다음 요청 추천 켜기·끄기 — 새로 띄우는 CLI부터 적용된다
ipcMain.handle("suggestions:get", () => promptSuggestionsOn);
ipcMain.handle("suggestions:set", (_event, on: unknown) => {
    promptSuggestionsOn = on === true;
    settings.save({promptSuggestions: promptSuggestionsOn});
    // 끄면 떠 있는 프로세스의 추천도 더는 화면에 보내지 않는다. 응답이 끝나고 추천을 기다리던 프로세스는
    // 입력을 바로 닫는다 — 열어 두면 곧바로 보낸 메시지가 추천을 켜고 띄운 그 프로세스로 이어진다.
    // CLI는 이미 만들고 있던 추천을 마치고(버려진다) 2~3초 뒤에 끝나고, 그사이 보낸 메시지는 그걸 기다렸다가
    // 추천을 끈 새 프로세스로 간다(실측). 백그라운드 작업이 있는 프로세스는 그대로 두고 추천만 버린다.
    if (!promptSuggestionsOn) {
        for (const tab of tabs.values()) {
            const s = tab.live;
            if (!s || !s.suggestions) continue;
            s.suggestions = false;
            if (s.waitingSuggestion && !s.turnActive && s.backgroundTasks === 0) endInput(s);
        }
    }
    return promptSuggestionsOn;
});

// 화면 테마. themeSource를 바꾸면 렌더러의 prefers-color-scheme이 바로 따라 바뀌고(styles/theme.css),
// 선택 상자 목록·폴더 선택 창 같은 기본 화면도 같이 바뀐다.
ipcMain.handle("theme:get", () => nativeTheme.themeSource);
ipcMain.handle("theme:set", (_event, source: unknown) => {
    if (!isThemeSource(source)) return nativeTheme.themeSource;
    nativeTheme.themeSource = source;
    settings.save({theme: source});
    return source;
});
ipcMain.handle("chat:set_fast_mode", (event, tabId: string, on: boolean) => {
    tabFor(event, tabId).fastMode = on;
    defaults.fastMode = on;
    settings.save({fastMode: on});
});

ipcMain.handle("models:list", () => loadModels());

ipcMain.handle("chat:get_rate_limits", () => rateLimitList());

// 이 사용자 메시지를 보내기 직전 상태로 Claude가 고친 파일을 되돌린다. 대화 내용은 그대로다.
// 백업은 세션 기록에 남아 있어 프로세스가 끝난 뒤에도 되돌릴 수 있다(실측).
// 갈라낸 대화로 복사된 메시지(터미널에서 갈라낸 것 포함)나 기록이 정리된 메시지는 되돌릴 기록이 없다
function explainRewind(r: RewindFilesResult): RewindFilesResult {
    if (r.canRewind || !r.error || !/no file checkpoint/i.test(r.error)) return r;
    return {...r, error: "이 메시지의 파일 기록이 없습니다 (갈라낸 대화로 복사된 메시지이거나, 기록이 정리됐습니다)"};
}

ipcMain.handle("chat:rewind_files", async (event, tabId: string, uuid: string, dryRun: boolean): Promise<RewindFilesResult> => {
    const tab = tabFor(event, tabId);
    const live = tab.live;
    if (live?.turnActive) return {canRewind: false, error: "응답이 끝난 뒤에 되돌릴 수 있습니다"};
    if (!tab.sessionId) return {canRewind: false, error: "세션 정보가 없습니다"};
    const s = live && !live.inputEnded ? live : null;
    if (s) return explainRewind(await s.q.rewindFiles(uuid, {dryRun}));

    const claudePath = resolveClaudePath();
    if (!claudePath) return {canRewind: false, error: "Claude CLI를 찾을 수 없습니다"};
    // 살아 있는 프로세스가 없으면 세션을 재개만 하고(턴은 시작하지 않는다) 되돌린 뒤 닫는다
    const idle = await openIdleQuery({
        pathToClaudeCodeExecutable: claudePath,
        cwd: tab.cwd,
        resume: tab.sessionId,
        enableFileCheckpointing: true,
    });
    try {
        return explainRewind(await withTimeout(idle.q.rewindFiles(uuid, {dryRun}), 20000));
    } catch (e) {
        return {canRewind: false, error: (e as Error).message};
    } finally {
        idle.close();
    }
});

// ── 탭 열기·닫기·저장 ──
// 렌더러가 새 탭을 만들 때, 탭에 저장된 대화를 열 때(사이드바·앱 재시작 후 복원) 부른다.
// 설정을 넘기지 않으면 지금 탭의 것(이미 있던 탭) 또는 기본값(새 탭)을 쓴다.
// 세션 폴더가 지워졌으면 옮길 수 없는데, CLI는 어느 폴더에서든 세션을 찾아 이어 주므로 에러 없이
// 지금 폴더에서 대화가 계속된다(실측). 렌더러가 경고할 수 있게 그 사실을 함께 돌려준다.
interface TabInit {
    cwd?: unknown;
    sessionId?: unknown;
    model?: unknown;
    effort?: unknown;
    ultracode?: unknown;
    fastMode?: unknown;
}

ipcMain.handle("tabs:open", async (event, tabId: string, init: TabInit = {}) => {
    const tab = tabFor(event, tabId);
    resetConversation(tab);
    if (typeof init.model === "string" && init.model) tab.model = init.model;
    if (typeof init.effort === "string" && init.effort) tab.effort = init.effort;
    if (typeof init.ultracode === "boolean") tab.ultracode = init.ultracode;
    if (typeof init.fastMode === "boolean") tab.fastMode = init.fastMode;
    // 허용 규칙은 세션 ID별로 남아 있어서 이 대화로 돌아오면 다시 적용된다
    tab.sessionId = typeof init.sessionId === "string" && init.sessionId ? init.sessionId : null;
    const wanted = typeof init.cwd === "string" && init.cwd ? init.cwd : tab.cwd;
    const cwdMissing = !fs.existsSync(wanted);
    if (!cwdMissing) tab.cwd = wanted;
    pushFolderInfo(tab);
    // 다시 켜서 복원한 탭의 대화 기록이 그사이 사라졌을 수 있다(터미널에서 삭제, CLI의 오래된 기록 정리).
    // getSessionMessages는 없는 세션에도 빈 배열을 돌려주고, 그대로 resume하면 보낼 때마다
    // "No conversation found with session ID"로 실패한다(확인함) — 새 대화로 시작한다.
    let sessionMissing = false;
    const wantedSid = tab.sessionId;
    if (wantedSid) {
        let exists = true; // 확인하지 못하면 있는 것으로 둔다 — 멀쩡한 대화를 비우지 않게
        try {
            const {getSessionInfo} = await loadSdk();
            exists = (await getSessionInfo(wantedSid)) !== undefined; // dir 없이 = 모든 프로젝트에서 찾는다
        } catch {
            // 무시
        }
        if (!exists && tab.sessionId === wantedSid) {
            tab.sessionId = null;
            sessionMissing = true;
        }
    }
    // 작업 파일 패널: 이 대화에서 고친 파일을 세션 기록에서 다시 계산
    const sid = tab.sessionId;
    if (sid) {
        void loadChangedFilesFromSession(tab, sid).then((ok) => {
            if (ok) sendChangedFiles(tab);
        });
    }
    return {
        cwd: tab.cwd,
        cwdMissing,
        sessionMissing,
        model: tab.model,
        effort: tab.effort,
        ultracode: tab.ultracode,
        fastMode: tab.fastMode,
        skipPermissions: tab.skipPermissions,
    };
});

// 탭을 닫으면 그 탭의 CLI 프로세스(백그라운드 작업 포함)도 끝낸다
ipcMain.handle("tabs:close", (_event, tabId: string) => {
    const tab = tabs.get(tabId);
    if (tab) disposeTab(tab, "탭을 닫았습니다");
});

// 탭을 없앤다: 띄우는 중인 턴 취소, 첫 메시지 재생성 되돌리기, CLI 프로세스(백그라운드 작업 포함) 종료, 대기 중인 허용 요청 정리
function disposeTab(tab: ChatTab, reason: string) {
    tab.stopEpoch++;
    restoreReplaceFirst(tab);
    closeLive(tab);
    settlePendingPermissions(tab, reason);
    tabs.delete(tab.id);
}

// 이 화면(webContents)의 탭을 모두 없앤다 — 창을 닫았거나 화면이 새로 시작했다.
// 그대로 두면 아무도 보지 않는 CLI가 계속 돌고, 허용 요청은 답할 곳이 없어 멈춰 있다가
// 탭을 다시 열 때(tabs:open의 대화 초기화) 끊긴다.
function disposeTabsOf(sender: Electron.WebContents, reason: string) {
    for (const tab of [...tabs.values()]) {
        if (tab.sender === sender) disposeTab(tab, reason);
    }
}

// ── 창 닫기·새로고침·앱 종료: 실행 중인 작업이 있으면 먼저 묻는다 ──
// 판단은 main이 한다(렌더러가 멈췄어도 동작하게). 응답 중 = 보내는 중(CLI 띄우는 중 포함)이거나 턴이 도는 중
// (CLI가 스스로 시작한 후속 턴 포함). 백그라운드 = 화면의 "백그라운드 N"과 같은 기준(ambient 제외).
function busySummary(sender?: Electron.WebContents): {responding: number; background: number} {
    let responding = 0;
    let background = 0;
    for (const tab of tabs.values()) {
        if (sender && tab.sender !== sender) continue;
        const s = tab.live && !tab.live.stopped ? tab.live : null;
        if ((tab.sending > 0 && !tab.live?.stopped) || s?.turnActive) responding++;
        if (s) background += [...s.bgMembers.values()].filter((m) => !m.ambient).length;
    }
    return {responding, background};
}

type StopAction = "close" | "reload" | "quit";

const STOP_ACTION_TEXT: Record<StopAction, {button: string; verb: string}> = {
    close: {button: "창 닫기", verb: "창을 닫으면"},
    reload: {button: "새로고침", verb: "새로고침하면"},
    quit: {button: "종료", verb: "앱을 종료하면"},
};

// 실행 중인 게 없으면 묻지 않고 true. 있으면 확인창 — 계속하면 true.
function confirmStopWork(win: BrowserWindow | null, action: StopAction): boolean {
    const {responding, background} = busySummary(action === "quit" ? undefined : win?.webContents);
    if (responding === 0 && background === 0) return true;
    const parts: string[] = [];
    if (responding > 0) parts.push(`응답 중인 탭 ${responding}개`);
    if (background > 0) parts.push(`백그라운드 작업 ${background}개`);
    const text = STOP_ACTION_TEXT[action];
    const options: Electron.MessageBoxSyncOptions = {
        type: "warning",
        buttons: [text.button, "취소"],
        defaultId: 0,
        cancelId: 1,
        message: "실행 중인 작업이 있습니다",
        detail: `${parts.join(", ")}가 있습니다.\n${text.verb} 모두 멈춥니다.`,
    };
    const choice = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
    return choice === 0;
}

// 종료(⌘Q, Dock의 종료)는 before-quit에서 한 번만 묻는다 — 이어서 창이 닫힐 때 또 묻지 않게
let quitting = false;

app.on("before-quit", (e) => {
    if (quitting) return;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    if (!confirmStopWork(win, "quit")) {
        e.preventDefault();
        return;
    }
    quitting = true;
});

// 신호(kill, 개발 중 터미널의 Ctrl+C)로 끝낼 때는 묻지 않는다 — 대화상자는 아무도 못 보고, 그동안 끝나지 않는다.
// (macOS 로그아웃·시스템 종료는 신호가 아니라 before-quit으로 오므로 그때는 묻는다.)
// Electron(Chromium)은 시작할 때(ready 전) 자기 신호 처리기를 단다: 첫 신호는 정상 종료(before-quit → 확인창),
// 그다음 신호는 기본 동작 = 즉시 죽음이라 자식 CLI와 백그라운드 작업이 고아로 남는다(둘 다 확인함).
// Node의 process.on은 그 신호의 첫 리스너일 때만 OS에 처리기를 등록하므로, ready 뒤에 불러야 Chromium 것을 덮는다.
function installSignalQuit() {
    let received = 0;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            received++;
            if (received > 1) {
                // 정상 종료가 멈췄다 — CLI 프로세스(백그라운드 작업 포함)를 정리하고 바로 끝낸다
                for (const tab of [...tabs.values()]) disposeTab(tab, "앱을 종료합니다");
                app.exit(1);
                return;
            }
            quitting = true;
            app.quit();
        });
    }
}

// 창을 닫을 때 묻고, 닫히면 그 창의 탭을 정리한다. macOS는 창을 닫아도 앱이 남는다 — 정리하지 않으면
// 응답이 화면 없이 계속 돌았다.
function guardWindow(win: BrowserWindow) {
    const contents = win.webContents; // closed 뒤에는 win.webContents에 접근할 수 없다
    win.on("close", (e) => {
        if (quitting) return;
        if (!confirmStopWork(win, "close")) e.preventDefault();
    });
    win.on("closed", () => disposeTabsOf(contents, "창을 닫았습니다"));
}

// 열려 있던 탭 목록 — 앱을 다시 켜면 그대로 연다. 순서·제목·고른 탭은 렌더러가 알아서 렌더러가 저장한다.
interface SavedTab {
    id: string;
    sessionId: string | null;
    cwd: string;
    title: string;
    customTitle: string | null; // 사용자가 붙인 탭 이름
    model: string;
    effort: string;
    ultracode: boolean;
    fastMode: boolean;
}

interface SavedTabs {
    tabs: SavedTab[];
    activeId: string | null;
}

function tabsFile(): string {
    return path.join(app.getPath("userData"), "tabs.json");
}

function cleanSavedTabs(raw: unknown): SavedTabs {
    const r = (raw ?? {}) as {tabs?: unknown; activeId?: unknown};
    const list = Array.isArray(r.tabs) ? r.tabs : [];
    const out: SavedTab[] = [];
    for (const item of list.slice(0, 50)) {
        const t = (item ?? {}) as Record<string, unknown>;
        if (typeof t.id !== "string" || !t.id) continue;
        out.push({
            id: t.id,
            sessionId: typeof t.sessionId === "string" && t.sessionId ? t.sessionId : null,
            cwd: typeof t.cwd === "string" ? t.cwd : "",
            title: typeof t.title === "string" ? t.title.slice(0, 200) : "",
            customTitle: typeof t.customTitle === "string" && t.customTitle.trim() ? t.customTitle.trim().slice(0, 60) : null,
            model: typeof t.model === "string" ? t.model : defaults.model,
            effort: typeof t.effort === "string" ? t.effort : defaults.effort,
            ultracode: t.ultracode === true,
            fastMode: t.fastMode === true,
        });
    }
    const activeId = typeof r.activeId === "string" && out.some((t) => t.id === r.activeId) ? r.activeId : out[0]?.id ?? null;
    return {tabs: out, activeId};
}

ipcMain.handle("tabs:load", (event) => {
    // 화면이 새로 시작했다(새로고침, 개발자 도구의 ⌘R 등). 이 화면에 남아 있는 탭은 이전 화면의 것이라
    // 아무도 보지 않는다 — CLI 프로세스를 정리하고, 탭은 저장된 목록에서 새로 연다.
    disposeTabsOf(event.sender, "화면을 새로 고쳤습니다");
    return cleanSavedTabs(readJsonFile<unknown>(tabsFile(), {tabs: [], activeId: null}));
});
ipcMain.handle("tabs:save", (_event, state: unknown) => {
    try {
        writeJsonFile(tabsFile(), cleanSavedTabs(state));
    } catch (e) {
        console.error("[tabs] 저장 실패", e);
    }
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
    const [entries, commandOutputs] = await Promise.all([
        getSessionMessages(sid, {dir: cwd || undefined}),
        localCommandOutputs(sid).catch(() => new Map<string, string>()),
    ]);
    const list = sessionToMessages(entries, {commandOutputs});
    // 앱이 갈라낸 대화면 복사된 메시지까지 표시 — 그 메시지들로는 파일을 되돌릴 수 없다
    const until = forkPoints()[sid]?.until;
    const end = until ? list.findIndex((m) => m.uuid === until || m.replyUuid === until) : -1;
    for (let i = 0; i <= end; i++) list[i].copied = true;
    return list;
});

// ── 에이전트가 한 일 ── 대화 속 에이전트 호출(Agent 도구의 tool_use id) → 에이전트 id → 그 에이전트의 기록
// (<세션>/subagents/agent-<id>.jsonl). 실행 중인 것은 task_started가 (task_id = 에이전트 id, tool_use_id)를 알려
// 준다(확인함). 그 밖(끝난 지 오래됐거나 다시 연 대화)은 listSubagents로 목록을 받아 각 기록의 첫 항목
// parent_tool_use_id(= 그 에이전트를 부른 호출)로 잇는다. 에이전트가 부른 에이전트도 같은 방식으로 이어진다.
const agentIdsBySession = new Map<string, Map<string, string>>(); // 세션 → (tool_use id → 에이전트 id)

async function agentIdFor(tab: ChatTab, toolUseId: string): Promise<string | null> {
    const sid = tab.sessionId;
    if (!sid) return null;
    let map = agentIdsBySession.get(sid);
    if (!map) {
        map = new Map();
        agentIdsBySession.set(sid, map);
    }
    const known = map.get(toolUseId);
    if (known) return known;
    for (const [taskId, d] of tab.live?.taskInfo ?? []) {
        if (d.toolUseId === toolUseId) {
            map.set(toolUseId, taskId);
            return taskId;
        }
    }
    const sdk = await loadSdk();
    const ids = await sdk.listSubagents(sid).catch(() => [] as string[]);
    const mapped = new Set(map.values());
    for (const id of ids) {
        if (mapped.has(id)) continue;
        const first = (await sdk.getSubagentMessages(sid, id, {limit: 1}).catch(() => []))[0];
        if (first?.parent_tool_use_id) map.set(first.parent_tool_use_id, id);
    }
    return map.get(toolUseId) ?? null;
}

type AgentStatus = "running" | "completed" | "failed" | "stopped" | "done";

// 끝난 작업 기록(task_notification) → 그 상태, 지금 프로세스에서 돌고 있으면 실행 중, 그 밖(다시 연 대화 등)은 "끝남"
function agentStatus(tab: ChatTab, agentId: string): AgentStatus {
    const fin = tab.taskStatuses.get(agentId) ?? tab.finishedTasks.find((t) => t.id === agentId)?.status;
    if (fin) return fin;
    const s = tab.live;
    if (s && !s.stopped && (s.bgMembers.has(agentId) || (s.turnActive && s.taskInfo.has(agentId)))) return "running";
    return "done";
}

ipcMain.handle("agents:get", async (event, tabId: string, ref: {toolUseId?: unknown; agentId?: unknown}) => {
    const tab = tabFor(event, tabId);
    const sid = tab.sessionId;
    if (!sid) return {ok: false, error: "아직 저장된 대화가 아닙니다"};
    try {
        const agentId =
            typeof ref?.agentId === "string" && ref.agentId
                ? ref.agentId
                : typeof ref?.toolUseId === "string" && ref.toolUseId
                  ? await agentIdFor(tab, ref.toolUseId)
                  : null;
        if (!agentId) {
            return {ok: false, error: "이 에이전트의 기록을 찾지 못했습니다 (기록이 정리됐거나, 갈라낸 대화라 따라오지 않았을 수 있습니다)"};
        }
        const status = agentStatus(tab, agentId);
        const {getSubagentMessages} = await loadSdk();
        const entries = await getSubagentMessages(sid, agentId);
        if (entries.length === 0) {
            return status === "running"
                ? {ok: false, pending: true, error: "에이전트가 막 시작했습니다…"}
                : {ok: false, error: "이 에이전트의 기록이 없습니다"};
        }
        // 수치: 도구 횟수, 걸린 시간(첫·끝 항목 시각), 토큰 = 마지막 응답이 쓴 컨텍스트 + 출력(CLI의 "N tokens"와 같은 셈)
        let toolUses = 0;
        let lastUsage: ApiUsage | null = null;
        for (const e of entries) {
            const m = e.message as {content?: unknown; usage?: ApiUsage} | undefined;
            if (e.type !== "assistant") continue;
            if (Array.isArray(m?.content)) toolUses += (m.content as {type?: string}[]).filter((b) => b.type === "tool_use").length;
            if (m?.usage) lastUsage = m.usage;
        }
        const first = entryTime(entries[0]);
        const last = entryTime(entries[entries.length - 1]);
        const tokens = lastUsage
            ? (lastUsage.input_tokens ?? 0) +
              (lastUsage.cache_creation_input_tokens ?? 0) +
              (lastUsage.cache_read_input_tokens ?? 0) +
              (lastUsage.output_tokens ?? 0)
            : undefined;
        return {
            ok: true,
            agentId,
            status,
            messages: sessionToMessages(entries, {subagent: true}),
            toolUses,
            tokens,
            durationMs: first && last && last >= first ? last - first : undefined,
        };
    } catch (e) {
        console.error("[agents] 에이전트 기록 읽기 실패", e);
        return {ok: false, error: (e as Error).message};
    }
});

// ── 대화 갈라지기 ── 이 답변까지를 새 세션으로 복사한다(원래 대화는 그대로). 렌더러가 새 탭으로 연다.
// 새 세션은 파일 되돌리기 기록 없이 시작하고(SDK), "항상 허용"한 규칙은 같은 대화를 잇는 것이라 함께 옮긴다.
ipcMain.handle("chat:fork", async (event, tabId: string, replyUuid: unknown) => {
    const tab = tabFor(event, tabId);
    const sid = tab.sessionId;
    if (!sid) return {ok: false, error: "아직 저장된 대화가 아닙니다"};
    if (typeof replyUuid !== "string" || !replyUuid) return {ok: false, error: "갈라낼 지점이 없습니다"};
    try {
        const sdk = await loadSdk();
        const entries = await sdk.getSessionMessages(sid);
        if (!entries.some((e) => e.uuid === replyUuid)) {
            return {ok: false, error: "이 지점을 대화 기록에서 찾지 못했습니다 (대화를 요약한 이전이거나 기록이 바뀌었습니다)"};
        }
        const info = await sdk.getSessionInfo(sid).catch(() => undefined);
        const base = (info?.customTitle || info?.summary || info?.firstPrompt || "대화").replace(/\s*\((?:갈래|fork)\)\s*$/i, "").trim();
        const title = `${base.length > 60 ? base.slice(0, 59) + "…" : base} (갈래)`;
        const {sessionId} = await sdk.forkSession(sid, {upToMessageId: replyUuid, title});
        const copied = await sdk.getSessionMessages(sessionId);
        const until = copied[copied.length - 1]?.uuid;
        if (until) saveForkPoints({...forkPoints(), [sessionId]: {until, at: Date.now()}});
        const g = grantsBySession.get(sid);
        if (g) grantsBySession.set(sessionId, {tools: [...g.tools], directories: [...g.directories], acceptEdits: g.acceptEdits});
        return {ok: true, sessionId, title, cwd: tab.cwd};
    } catch (e) {
        console.error("[fork] 대화 갈라내기 실패", e);
        return {ok: false, error: (e as Error).message};
    }
});

// 탭별 사용량 창: 아직 열지 않은 탭(복원만 된 탭)의 대화별 저장된 비용·토큰 누계
ipcMain.handle("sessions:stats", (_event, sids: unknown) => {
    if (!Array.isArray(sids)) return {};
    const saved = sessionStats().sessions;
    const out: Record<string, {cost?: number; usage?: TokenTotals}> = {};
    for (const sid of sids.slice(0, 100)) {
        if (typeof sid !== "string") continue;
        const s = saved[sid];
        if (s && (typeof s.cost === "number" || s.usage)) out[sid] = {cost: s.cost, usage: s.usage};
    }
    return out;
});

ipcMain.handle("sessions:delete", async (_event, sid: string, cwd?: string) => {
    forgetSession(sid);
    // 이 대화를 열어 둔 탭은 새 대화로 비운다 (화면은 렌더러가 비운다)
    for (const tab of tabs.values()) {
        if (tab.sessionId === sid) resetConversation(tab);
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

ipcMain.handle("commands:list", async (event, tabId: string, refresh?: boolean) => {
    const tab = tabFor(event, tabId);
    const list = await loadCommands(tab, refresh === true);
    // 새로 받은 목록은 입력창의 "/" 메뉴에도 — 다시 묻지 않아도 그 명령이 메뉴에 보이게
    if (refresh === true) send(tab, "chat:commands", list);
    return list;
});

ipcMain.handle("mcp:status", (event, tabId: string, refresh?: boolean) => loadMcpStatus(tabFor(event, tabId), refresh === true));

// ── MCP 서버 로그인·다시 연결·로그아웃 (MCP 팝업) — 로그인 진행 상태는 mcp:login 이벤트로 모든 창에 간다 ──
ipcMain.handle("mcp:login", (event, tabId: string, name: unknown): Promise<McpLoginState> => {
    if (typeof name !== "string" || !name) {
        return Promise.resolve({name: "", phase: "error", seq: ++mcpLoginSeq, error: "서버 이름이 없습니다"});
    }
    return startMcpLogin(tabFor(event, tabId), name);
});

ipcMain.handle("mcp:login_cancel", (_event, name: unknown) => {
    const flow = typeof name === "string" ? mcpLogins.get(name) : undefined;
    if (flow) endMcpLogin(flow, {phase: "cancelled"});
});

// 화면을 새로 띄웠을 때(새로고침) 진행 중인 로그인
ipcMain.handle("mcp:login_states", () => [...mcpLogins.values()].map((f) => f.state));

// [다시 연결](실패한 서버)·[다시 확인](claude.ai 커넥터): 살아 있는 세션이 있으면 그 세션에서 다시 연결하고, 없으면 폴더를
// 다시 살펴본다(새 CLI가 처음부터 연결한다). 목록을 못 받으면 null — 렌더러는 보던 목록을 그대로 둔다.
ipcMain.handle("mcp:reconnect", async (event, tabId: string, name: unknown): Promise<AppMcpServer[] | null> => {
    const tab = tabFor(event, tabId);
    const cwd = tab.cwd;
    if (typeof name !== "string" || !name) return null;
    const s = tab.live && !tab.live.inputEnded && !tab.live.stopped ? tab.live : null;
    let status: McpServerStatus[] | null = null;
    if (s) {
        // 연결되지 않으면 예외가 난다("Server status: failed") — 이유는 목록의 error에 있다
        await withTimeout(s.q.reconnectMcpServer(name), 30_000).catch((e) => console.error("[mcp] 다시 연결 실패", name, (e as Error)?.message));
        status = await withTimeout(s.q.mcpServerStatus(), 5000).catch(() => null);
    }
    if (!status) status = await probeFolder(cwd, true).mcp;
    if (!status) return null;
    const me = status.find((m) => m.name === name);
    // claude.ai에서 연결을 마쳤다 — 로그인처럼 다른 폴더·탭의 목록과 세션에도 반영한다
    if (me?.status === "connected" && me.config?.type === "claudeai-proxy") refreshMcpEverywhere(name, {cwd, list: status}, s ?? undefined);
    const list = toMcpList(status);
    if (cwd === tab.cwd) send(tab, "chat:mcp", list);
    return list;
});

// [로그아웃](연결된 HTTP·SSE 서버): CLI가 저장한 토큰을 지운다(서버가 토큰 폐기 주소를 알리면 폐기도 요청한다 — 실측).
// 터미널의 claude와 같은 저장소라 거기서도 로그아웃된다. 살아 있는 세션이 있으면 그 세션에서(그 세션은 스스로 다시 연결해
// "인증 필요"가 된다), 없으면 그 폴더에 잠깐 띄운 CLI에서 한다.
ipcMain.handle("mcp:logout", async (event, tabId: string, name: unknown): Promise<{ok: true} | ({ok: false} & McpLoginError)> => {
    const tab = tabFor(event, tabId);
    if (typeof name !== "string" || !name) return {ok: false, error: "서버 이름이 없습니다"};
    const cwd = tab.cwd;
    const s = tab.live && !tab.live.inputEnded && !tab.live.stopped ? tab.live : null;
    let idle: {q: Query; close: () => void} | null = null;
    try {
        let q: Query;
        if (s) {
            q = s.q;
        } else {
            const claudePath = resolveClaudePath();
            if (!claudePath) return {ok: false, error: "Claude CLI를 찾지 못했습니다"};
            idle = await openIdleQuery({pathToClaudeCodeExecutable: claudePath, cwd});
            q = idle.q;
            await withTimeout(q.initializationResult(), 30_000);
        }
        const api = q as unknown as McpAuthMethods;
        if (typeof api.mcpClearAuth !== "function") {
            return {ok: false, error: "이 버전에서는 앱에서 로그아웃할 수 없습니다 — 터미널에서 /mcp로 하세요", unavailable: true};
        }
        // Claude 계정 로그인은 어떤 경우에도 건드리지 않는다 — 지우는 건 자체 OAuth를 쓰는 HTTP·SSE 서버의 토큰뿐이다.
        // CLI도 그 밖의 종류는 "Cannot clear auth"로 거절하지만(2.1.325 확인), claude.ai 커넥터는 Claude 계정으로
        // 붙으므로 CLI가 바뀌어도 앱이 먼저 막는다. 서버 목록을 못 읽으면(시간 초과) 지우지 않는다.
        const target = (await withTimeout(q.mcpServerStatus(), 5000)).find((m) => m.name === name);
        const serverType = (target?.config as {type?: string} | undefined)?.type;
        if (!target || target.scope === "claudeai" || (serverType !== "http" && serverType !== "sse")) {
            return {ok: false, error: "이 서버는 앱에서 로그아웃할 수 없습니다"};
        }
        await withTimeout(api.mcpClearAuth(name), 30_000);
        const list = await withTimeout(q.mcpServerStatus(), 5000).catch(() => null);
        refreshMcpEverywhere(name, list ? {cwd, list} : null, s ?? undefined);
        return {ok: true};
    } catch (e) {
        return {ok: false, ...explainMcpLoginError((e as Error)?.message ?? String(e))};
    } finally {
        idle?.close();
    }
});

// 앱을 끄면 기다리던 로그인도 끝낸다 — CLI와 그 콜백 서버를 남기지 않게
app.on("will-quit", () => {
    for (const flow of [...mcpLogins.values()]) endMcpLogin(flow, {phase: "cancelled"});
});

ipcMain.handle("files:search", (event, tabId: string, query: string) => searchFilesInCwd(tabFor(event, tabId).cwd, query ?? ""));

// 탭의 작업 폴더 바꾸기 — 그 탭은 새 대화로 시작한다(전체 허용)
ipcMain.handle("dialog:select_directory", async (event, tabId: string) => {
    const tab = tabFor(event, tabId);
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        defaultPath: tab.cwd,
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    resetConversation(tab);
    tab.cwd = result.filePaths[0];
    pushFolderInfo(tab);
    return tab.cwd;
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

// 그림 복사 (크게 보기) — 렌더러가 캔버스로 PNG를 만들어 넘긴다 (SVG·WebP도 붙여 넣을 수 있게)
ipcMain.handle("clipboard:write_image", (_event, dataUrl: unknown) => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return false;
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
});

// ── macOS 알림 ──
// 언제 띄울지(앱을 보고 있지 않을 때, 설정이 켜져 있을 때)는 렌더러가 정한다. 여기서는 보여 주기만 한다.
// 알림 객체를 들고 있지 않으면 가비지 컬렉션되어 눌러도 반응이 없다(Electron의 알려진 동작).
const shownNotifications = new Set<Notification>();

ipcMain.handle("notify:show", (event, n: {title?: unknown; body?: unknown; tabId?: unknown}) => {
    if (!Notification.isSupported()) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    // 알림을 누르면 그 알림을 낸 탭으로 간다 (렌더러가 탭을 고른다)
    const tabId = typeof n?.tabId === "string" ? n.tabId : null;
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
            if (tabId) win.webContents.send("notify:clicked", tabId);
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
    installSignalQuit(); // ready 뒤여야 한다 — 위 설명
    loadChatSettings();
    loadSavedRateLimits();
    installAppMenu({confirmReload: (win) => confirmStopWork(win, "reload")});
    installPreviewProtocol();
    const claudePath = resolveClaudePath();
    if (claudePath) {
        console.log(`[bootstrap] Claude CLI 감지: ${claudePath}`);
    } else {
        console.error(
            "[bootstrap] Claude CLI를 찾을 수 없습니다. " +
                "PATH에 추가하거나 CLAUDE_PATH 환경변수로 경로를 지정하세요."
        );
    }

    guardWindow(createMainWindow());
    // 테마를 바꾸면(앱 설정이든 macOS 화면 모드든) 창 바탕도 맞춘다 — 창 크기를 바꿀 때 가장자리에 예전 색이 비치지 않게
    nativeTheme.on("updated", () => {
        for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(windowBackground());
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            guardWindow(createMainWindow());
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
