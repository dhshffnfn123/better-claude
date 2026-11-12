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

// 세션 기록에서 복원한 메시지
interface LoadedMessage {
    role: "user" | "assistant";
    content: string;
    uuid?: string; // 사용자 메시지: 파일 되돌리기 기준점
    images?: string[];
    segments?: (
        | {kind: "text"; text: string}
        | {
              kind: "tool";
              tool: {id: string; name: string; input: unknown; status: "done" | "error"; resultPreview?: string};
          }
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

interface ChangedFilesState {
    turn: number; // 지금 몇 번째 응답인지 (lastTurn과 같으면 "방금 바뀐 파일")
    files: ChangedFile[];
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

interface Window {
    electronAPI: {
        sendMessage: (
            message: string,
            images?: { data: string; mediaType: string }[],
            replaceUuid?: string
        ) => Promise<void>;
        newConversation: () => Promise<void>;
        respondPermission: (id: string, allow: boolean, always?: boolean) => Promise<void>;
        rewindFiles: (uuid: string, dryRun: boolean) => Promise<RewindFilesResult>;
        getRateLimits: () => Promise<RateLimitWindow[]>;
        onTurnUuid: (callback: (data: { uuid: string }) => void) => () => void;
        onRateLimits: (callback: (limits: RateLimitWindow[]) => void) => () => void;
        answerQuestions: (id: string, answers: string[][]) => Promise<void>;
        getPermissions: () => Promise<boolean>;
        setPermissions: (allow: boolean) => Promise<void>;
        stopGeneration: () => Promise<void>;
        onChunk: (callback: (text: string) => void) => () => void;
        onDone: (callback: () => void) => () => void;
        onUsage: (callback: (data: { inputTokens: number; outputTokens: number }) => void) => () => void;
        onThinking: (callback: (text: string) => void) => () => void;
        onToolUse: (
            callback: (data: { id: string; name: string; input: unknown; parentToolUseId?: string }) => void
        ) => () => void;
        onToolResult: (
            callback: (data: { id: string; isError: boolean; content: string; parentToolUseId?: string }) => void
        ) => () => void;
        onChatError: (
            callback: (data: { level: "error" | "warning"; message: string; detail?: string }) => void
        ) => () => void;
        onPermissionRequest: (callback: (data: PermissionRequestData) => void) => () => void;
        onQuestionRequest: (callback: (data: { id: string; questions: AskQuestion[] }) => void) => () => void;
        onPermissionResolved: (callback: (data: { id: string | null }) => void) => () => void;
        getPathForFile: (file: File) => string;
        onTurnStart: (callback: () => void) => () => void;
        onBackgroundTasks: (callback: (state: BackgroundState) => void) => () => void;
        clearFinishedBackground: () => Promise<void>;
        copyText: (text: string) => Promise<boolean>;
        showNotification: (n: {title: string; body: string}) => Promise<boolean>;
        getChangedFiles: () => Promise<ChangedFilesState>;
        onChangedFiles: (callback: (state: ChangedFilesState) => void) => () => void;
        getFileChanges: (path: string) => Promise<FileHunk[]>;
        listDir: (dir: string) => Promise<DirListing | null>;
        readFileForView: (path: string) => Promise<FileView>;
        revealFile: (path: string) => Promise<void>;
        gitStatus: () => Promise<GitStatusResult>;
        gitDiff: (path: string) => Promise<GitDiffResult>;
        getBackgroundOutput: (taskId: string) => Promise<BackgroundOutput | null>;
        stopBackgroundTask: (taskId: string) => Promise<void>;
        onCost: (callback: (data: { totalCostUsd: number }) => void) => () => void;
        onContextUsage: (callback: (data: ContextUsage) => void) => () => void;
        getCwd: () => Promise<string>;
        searchFiles: (query: string) => Promise<string[]>;
        selectDirectory: () => Promise<string | null>;
        getModel: () => Promise<string>;
        setModel: (model: string) => Promise<void>;
        getEffort: () => Promise<string>;
        setEffort: (effort: string) => Promise<void>;
        getUltracode: () => Promise<boolean>;
        setUltracode: (on: boolean) => Promise<void>;
        getFastMode: () => Promise<boolean>;
        setFastMode: (on: boolean) => Promise<void>;
        listModels: () => Promise<ClaudeModelInfo[] | null>;
        getPrompts: () => Promise<string[]>;
        addPrompt: (prompt: string) => Promise<string[]>;
        removePrompt: (index: number) => Promise<string[]>;
        listCommands: () => Promise<SlashCommand[]>;
        getSessionId: () => Promise<string | null>;
        resumeSession: (sessionId: string, cwd?: string) => Promise<{cwd: string; cwdMissing: boolean}>;
        listSessions: () => Promise<SessionSummary[]>;
        loadSessionMessages: (sessionId: string, cwd?: string) => Promise<LoadedMessage[]>;
        deleteSession: (sessionId: string, cwd?: string) => Promise<void>;
        getMcpStatus: (refresh?: boolean) => Promise<McpServer[]>;
        onCommands: (callback: (commands: SlashCommand[]) => void) => () => void;
        onMcpStatus: (callback: (servers: McpServer[]) => void) => () => void;
        getClaudeStatus: () => Promise<{ found: boolean; path: string | null }>;
        locateClaude: () => Promise<
            | { ok: true; path: string }
            | { ok: false; cancelled?: boolean; error?: string }
        >;
        openClaudeInstallGuide: () => Promise<void>;
        onClaudeNotFound: (callback: () => void) => () => void;
    };
}
