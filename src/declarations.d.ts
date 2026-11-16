declare module "*.module.scss" {
    const styles: { [className: string]: string };
    export default styles;
}

declare module "*.png" {
    const src: string;
    export default src;
}

// CLI 세션 기록 목록의 한 항목
interface SessionSummary {
    sessionId: string;
    title: string;
    cwd: string;
    cwdMissing: boolean; // 작업 폴더가 지워짐
    lastModified: number;
    gitBranch?: string;
}

// 대화 압축(/compact, 또는 컨텍스트가 차서 자동) — 답변 안의 구분선. 앞 대화가 이 요약으로 바뀌었다.
interface CompactInfo {
    trigger?: "manual" | "auto";
    preTokens?: number; // 압축 전·후 컨텍스트 토큰 (라이브만 — 기록에는 SDK가 넘겨주지 않는다)
    postTokens?: number;
    summary?: string; // CLI가 쓴 요약(영어), 모델용 안내 문장은 뺀 것
    restored?: boolean; // 기록에서 불러옴 — 그 앞 메시지는 화면에 없다(요약 속에만 있다)
}

// main이 압축 진행을 알린다: start → done | failed → boundary(구분선) → summary(요약 본문)
interface CompactEvent extends CompactInfo {
    phase: "start" | "done" | "failed" | "boundary" | "summary";
    error?: string;
}

// 세션 기록에서 복원한 메시지
interface LoadedMessage {
    role: "user" | "assistant";
    content: string;
    uuid?: string; // 사용자 메시지: 파일 되돌리기 기준점
    images?: string[];
    // "N tokens" 배지 — 기록의 응답별 usage로 계산 (내 메시지: 그 턴의 입력, 답변: 그 턴의 출력)
    inputTokens?: number;
    outputTokens?: number;
    segments?: (
        | {kind: "text"; text: string}
        | {
              kind: "tool";
              tool: {id: string; name: string; input: unknown; status: "done" | "error"; resultPreview?: string};
          }
        | ({kind: "compact"} & CompactInfo)
    )[];
}

interface McpServer {
    name: string;
    status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
    error?: string;
    scope?: string;
    toolCount: number;
}

interface AskQuestionOption {
    label: string;
    description?: string;
}

interface AskQuestion {
    question: string;
    header: string;
    multiSelect?: boolean;
    options: AskQuestionOption[];
}

// SDK ModelInfo 중 화면에서 쓰는 필드만
interface ClaudeModelInfo {
    value: string;
    resolvedModel?: string;
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
    supportsFastMode?: boolean;
}

interface PermissionRequestData {
    id: string;
    toolName: string;
    title?: string;
    displayName?: string;
    blockedPath?: string;
    decisionReason?: string;
    target?: string;
    // "이 대화에서 항상 허용"을 고르면 허용되는 규칙들. 비어 있으면 그 선택지를 숨긴다.
    alwaysAllow?: string[];
    input: unknown;
}

interface RateLimitWindow {
    type: string; // five_hour, seven_day, seven_day_opus ...
    utilization?: number; // 0~1
    resetsAt?: number; // epoch 초
    status?: string; // allowed, allowed_warning, rejected
    receivedAt?: number; // 이 값을 받은 시각(epoch ms) — 앱을 다시 켜면 저장해 둔 마지막 값을 보여 준다
}

interface RewindFilesResult {
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
}

interface BackgroundTask {
    id: string;
    type: string; // local_bash, local_agent, local_workflow, monitor ...
    description: string;
    subagentType?: string; // 에이전트 종류 (general-purpose 등)
    workflowName?: string;
    prompt?: string; // 에이전트가 받은 지시
    command?: string; // 셸 작업의 명령
    hasOutput?: boolean; // 셸 출력을 읽을 수 있음 (getBackgroundOutput)
    startedAt?: number;
    activity?: string; // 지금 하는 일
    summary?: string; // 에이전트 진행 요약
    toolUses?: number;
    totalTokens?: number;
    lastToolName?: string;
    recentTools?: ToolStep[]; // 에이전트가 최근에 쓴 도구
    launchedByAgent?: boolean;
}

// 에이전트가 쓴 도구 한 번
interface ToolStep {
    id: string;
    name: string;
    target: string;
    status: "running" | "done" | "error";
}

// 이 대화에서 최근에 끝난 백그라운드 작업
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
    exitCode?: number; // 셸 작업의 종료 코드
    hasOutput: boolean;
    recentTools?: ToolStep[];
    launchedByAgent?: boolean;
}

interface BackgroundState {
    running: BackgroundTask[];
    finished: FinishedTask[];
}

// ── 작업 파일 패널 ──
// Claude가 이 대화에서 고친 파일
interface ChangedFile {
    path: string;
    edits: number;
    lastTurn: number; // 몇 번째 응답에서 마지막으로 바뀌었나
    lastAt: number;
}

// 파일을 열 JetBrains IDE (그 프로젝트를 마지막으로 연 IDE) — 없는 파일이면 not-found, IDE가 없으면 no-ide
type EditorTarget =
    | {ok: true; app: string; path: string; line?: number}
    | {ok: false; reason: "not-found" | "no-ide" | "error"; message?: string};

interface ChangedFilesState {
    turn: number; // 지금 몇 번째 응답인지 (lastTurn과 같으면 "방금 바뀐 파일")
    files: ChangedFile[];
    clearedAt?: number; // 내역을 지운 시각 — 이 뒤의 수정만 들어 있다
}

// 한 번의 수정 (Edit: 바뀐 부분, Write: 새 내용 전체)
interface FileHunk {
    tool: string;
    oldText: string;
    newText: string;
    at: number;
}

interface DirEntry {
    name: string;
    path: string;
    isDir: boolean;
}

interface DirListing {
    entries: DirEntry[];
    truncated: boolean;
}

interface FileView {
    text?: string;
    truncated?: boolean;
    binary?: boolean;
    missing?: boolean;
    error?: string;
    size?: number;
}

// 화면 테마: system이면 macOS 화면 모드를 따른다
type ThemeSource = "system" | "light" | "dark";

// "Git 변경" 보기 (main/services/git-changes.ts와 같은 모양)
type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflict";

interface GitChange {
    path: string;
    rel: string;
    origRel?: string;
    origPath?: string;
    kind: GitChangeKind;
    staged: boolean;
    unstaged: boolean;
    added?: number;
    deleted?: number;
    binary?: boolean;
}

interface GitBranch {
    head: string | null;
    detached: boolean;
    initial: boolean;
    upstream?: string;
    ahead?: number;
    behind?: number;
}

type GitStatusResult =
    | {ok: true; root: string; branch: GitBranch; files: GitChange[]; truncated: boolean}
    | {ok: false; reason: "no-git" | "not-repo" | "error"; message?: string};

interface GitDiffResult {
    text?: string;
    truncated?: boolean;
    binary?: boolean;
    untracked?: boolean;
    error?: string;
}

interface BackgroundOutput {
    text: string;
    truncated: boolean; // 앞부분이 잘렸음 (끝부분만 읽음)
}

interface ContextUsage {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
}

interface SlashCommand {
    name: string;
    description: string;
    argumentHint?: string;
    source: "builtin" | "custom";
}

// ── 탭 ──
// 탭에 대화를 열 때 넘기는 것 (빠진 건 main이 기본값·지금 값으로 채운다)
interface TabInit {
    cwd?: string;
    sessionId?: string | null;
    model?: string;
    effort?: string;
    ultracode?: boolean;
    fastMode?: boolean;
}

interface TabOpenResult {
    cwd: string;
    cwdMissing: boolean; // 세션의 작업 폴더가 없어 지금 폴더에서 이어간다
    sessionMissing: boolean; // 대화 기록이 사라져 새 대화로 시작한다 (세션 ID는 비웠다)
    model: string;
    effort: string;
    ultracode: boolean;
    fastMode: boolean;
    skipPermissions: boolean;
}

// 앱을 다시 켜면 다시 여는 탭
interface SavedTab {
    id: string;
    sessionId: string | null;
    cwd: string;
    title: string;
    model: string;
    effort: string;
    ultracode: boolean;
    fastMode: boolean;
}

interface SavedTabs {
    tabs: SavedTab[];
    activeId: string | null;
}

interface ChatNoticeData {
    level: "error" | "warning";
    message: string;
    detail?: string;
}

// main이 탭마다 보내는 이벤트와 그 내용 (preload의 TAB_EVENTS와 같은 이름)
interface TabEventMap {
    chunk: string;
    thinking: string;
    done: undefined;
    error: ChatNoticeData;
    usage: {inputTokens: number; outputTokens: number};
    toolUse: {id: string; name: string; input: unknown; parentToolUseId?: string};
    toolResult: {id: string; isError: boolean; content: string; parentToolUseId?: string};
    turnUuid: {uuid: string}; // 방금 보낸 사용자 메시지의 uuid (파일 되돌리기 기준점)
    turnStart: undefined; // 백그라운드 작업이 끝나 CLI가 스스로 시작한 턴
    permissionRequest: PermissionRequestData;
    questionRequest: {id: string; questions: AskQuestion[]}; // AskUserQuestion — 권한이 아니라 선택지 질문
    permissionResolved: {id: string | null}; // 더 이상 답할 수 없게 된 요청 (null이면 그 탭 전부)
    background: BackgroundState;
    cost: {totalCostUsd: number};
    context: ContextUsage;
    commands: SlashCommand[];
    mcp: McpServer[];
    changedFiles: ChangedFilesState;
    session: {sessionId: string}; // 새 대화에 세션 ID가 정해졌다
    compact: CompactEvent; // 대화 압축 진행
}

type TabEventName = keyof TabEventMap;

// 앱 메뉴의 탭 단축키
type TabMenuAction = "new" | "close" | "next" | "prev" | `select:${number}` | "find" | "find-next" | "find-prev";

interface Window {
    electronAPI: {
        openTab: (tabId: string, init?: TabInit) => Promise<TabOpenResult>;
        closeTab: (tabId: string) => Promise<void>;
        loadTabs: () => Promise<SavedTabs>;
        saveTabs: (state: SavedTabs) => Promise<void>;
        onTabEvent: <K extends TabEventName>(event: K, callback: (tabId: string, payload: TabEventMap[K]) => void) => () => void;
        onMenuTab: (callback: (action: TabMenuAction) => void) => () => void;

        sendMessage: (
            tabId: string,
            message: string,
            images?: { data: string; mediaType: string }[],
            replaceUuid?: string
        ) => Promise<void>;
        stopGeneration: (tabId: string) => Promise<void>;
        rewindFiles: (tabId: string, uuid: string, dryRun: boolean) => Promise<RewindFilesResult>;
        setPermissions: (tabId: string, allow: boolean) => Promise<void>;
        respondPermission: (id: string, allow: boolean, always?: boolean) => Promise<void>;
        answerQuestions: (id: string, answers: string[][]) => Promise<void>;

        setModel: (tabId: string, model: string) => Promise<void>;
        setEffort: (tabId: string, effort: string) => Promise<void>;
        setUltracode: (tabId: string, on: boolean) => Promise<void>;
        setFastMode: (tabId: string, on: boolean) => Promise<void>;
        listModels: () => Promise<ClaudeModelInfo[] | null>;

        selectDirectory: (tabId: string) => Promise<string | null>;
        searchFiles: (tabId: string, query: string) => Promise<string[]>;
        getFileChanges: (tabId: string, path: string) => Promise<FileHunk[]>;
        // "Claude 수정" 내역 지우기 (목록·표시만, 파일은 그대로) — files:changed로 빈 목록이 온다
        clearChangedFiles: (tabId: string) => Promise<void>;
        // 파일 경로("src/main.ts:120", "#L120", 절대 경로)를 JetBrains IDE로 — 어느 IDE로 열지 미리 알아보기 / 열기
        resolveEditorTarget: (tabId: string, raw: string) => Promise<EditorTarget>;
        openInEditor: (tabId: string, raw: string) => Promise<EditorTarget>;
        listDir: (tabId: string, dir: string) => Promise<DirListing | null>;
        readFileForView: (tabId: string, path: string) => Promise<FileView>;
        revealFile: (tabId: string, path: string) => Promise<void>;
        gitStatus: (tabId: string) => Promise<GitStatusResult>;
        gitDiff: (tabId: string, path: string) => Promise<GitDiffResult>;
        listCommands: (tabId: string) => Promise<SlashCommand[]>;
        getMcpStatus: (tabId: string, refresh?: boolean) => Promise<McpServer[]>;

        getBackgroundOutput: (tabId: string, taskId: string) => Promise<BackgroundOutput | null>;
        stopBackgroundTask: (tabId: string, taskId: string) => Promise<void>;
        clearFinishedBackground: (tabId: string) => Promise<void>;

        getPathForFile: (file: File) => string;
        getRateLimits: () => Promise<RateLimitWindow[]>;
        onRateLimits: (callback: (limits: RateLimitWindow[]) => void) => () => void;
        copyText: (text: string) => Promise<boolean>;
        showNotification: (n: {title: string; body: string; tabId?: string}) => Promise<boolean>;
        // 탭이 낸 macOS 알림을 눌렀다 → 그 탭으로
        onNotificationClick: (callback: (tabId: string) => void) => () => void;
        getTheme: () => Promise<ThemeSource>;
        setTheme: (source: ThemeSource) => Promise<ThemeSource>;
        getPrompts: () => Promise<string[]>;
        addPrompt: (prompt: string) => Promise<string[]>;
        removePrompt: (index: number) => Promise<string[]>;
        listSessions: () => Promise<SessionSummary[]>;
        loadSessionMessages: (sessionId: string, cwd?: string) => Promise<LoadedMessage[]>;
        deleteSession: (sessionId: string, cwd?: string) => Promise<void>;
        getClaudeStatus: () => Promise<{ found: boolean; path: string | null }>;
        locateClaude: () => Promise<
            | { ok: true; path: string }
            | { ok: false; cancelled?: boolean; error?: string }
        >;
        openClaudeInstallGuide: () => Promise<void>;
        onClaudeNotFound: (callback: () => void) => () => void;
    };
}
