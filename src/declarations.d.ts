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
    type: string;
    description: string;
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
        sendMessage: (message: string, images?: { data: string; mediaType: string }[]) => Promise<void>;
        newConversation: () => Promise<void>;
        respondPermission: (id: string, allow: boolean, always?: boolean) => Promise<void>;
        rewindFiles: (uuid: string, dryRun: boolean) => Promise<RewindFilesResult>;
        getRateLimits: () => Promise<RateLimitWindow[]>;
        onTurnUuid: (callback: (data: { uuid: string }) => void) => () => void;
        onRateLimits: (callback: (limits: RateLimitWindow[]) => void) => () => void;
        answerQuestions: (id: string, answers: string[][]) => Promise<void>;
        setPermissions: (allow: boolean) => Promise<void>;
        stopGeneration: () => Promise<void>;
        onChunk: (callback: (text: string) => void) => () => void;
        onDone: (callback: () => void) => () => void;
        onUsage: (callback: (data: { inputTokens: number; outputTokens: number }) => void) => () => void;
        onThinking: (callback: (text: string) => void) => () => void;
        onToolUse: (
            callback: (data: { id: string; name: string; input: unknown }) => void
        ) => () => void;
        onToolResult: (
            callback: (data: { id: string; isError: boolean; content: string }) => void
        ) => () => void;
        onChatError: (
            callback: (data: { level: "error" | "warning"; message: string; detail?: string }) => void
        ) => () => void;
        onPermissionRequest: (callback: (data: PermissionRequestData) => void) => () => void;
        onQuestionRequest: (callback: (data: { id: string; questions: AskQuestion[] }) => void) => () => void;
        onPermissionResolved: (callback: (data: { id: string | null }) => void) => () => void;
        getPathForFile: (file: File) => string;
        onTurnStart: (callback: () => void) => () => void;
        onBackgroundTasks: (callback: (tasks: BackgroundTask[]) => void) => () => void;
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
        resumeSession: (sessionId: string, cwd?: string) => Promise<string>;
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
