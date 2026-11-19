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

// 답변 속 그림 경로 확인 요청 (images:resolve). since: 이 시각(ms) 뒤에 바뀐 파일만, infoOnly: 경로만 확인
interface ImageRef {
    ref: string;
    since?: number;
    infoOnly?: boolean;
}

type ResolvedImage =
    | {ref: string; since?: number; infoOnly?: boolean; ok: true; path: string; name: string; size: number; thumb?: string; full?: boolean}
    | {ref: string; since?: number; infoOnly?: boolean; ok: false};

// 세션 기록에서 복원한 메시지
interface LoadedMessage {
    role: "user" | "assistant";
    content: string;
    uuid?: string; // 사용자 메시지: 파일 되돌리기 기준점
    images?: string[];
    // "N tokens" 배지 — 기록의 응답별 usage로 계산 (내 메시지: 그 턴의 입력, 답변: 그 턴의 출력)
    inputTokens?: number;
    outputTokens?: number;
    replyUuid?: string; // 답변: 그 답변의 마지막 기록 항목 (여기까지 새 탭으로)
    copied?: boolean; // 갈라낸 대화로 복사된 메시지 — 파일 되돌리기 기록이 없다
    segments?: (
        | {kind: "text"; text: string}
        | {
              kind: "tool";
              tool: {
                  id: string;
                  name: string;
                  input: unknown;
                  status: "done" | "error";
                  resultPreview?: string;
                  images?: string[]; // 도구 결과에 든 그림 (data URL)
                  imagesOmitted?: number; // 오래돼 싣지 않은 그림 수
                  startedAt?: number;
              };
          }
        | ({kind: "compact"} & CompactInfo)
    )[];
}

interface McpServer {
    name: string;
    status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
    error?: string;
    scope?: string;
    // 연결 방식: http | sse | stdio | claudeai-proxy(claude.ai 커넥터) | sdk
    transport: string;
    toolCount: number;
}

// MCP 서버 로그인 진행 (서버 이름별, 앱 전체) — main의 mcp:login 이벤트
// starting = CLI를 띄워 로그인 주소를 받는 중, waiting = 브라우저에서 허용을 기다림, claudeai = claude.ai 설정을 열었다(거기서 연결),
// done = 로그인했다, error = 실패(error = 짧은 한국어, detail = CLI 원문), cancelled = 취소했다
type McpLoginPhase = "starting" | "waiting" | "claudeai" | "done" | "error" | "cancelled";

interface McpLoginState {
    name: string;
    phase: McpLoginPhase;
    seq: number; // 바뀔 때마다 오른다 — 늦게 온 옛 상태를 버린다
    error?: string;
    detail?: string;
    unavailable?: boolean; // 이 SDK·CLI로는 앱에서 로그인할 수 없다 — 터미널 안내
}

type McpLogoutResult = {ok: true} | {ok: false; error: string; detail?: string; unavailable?: boolean};

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

// "에이전트가 한 일" 패널을 여는 대상: 대화 속 Agent 호출(toolUseId) 또는 백그라운드 작업 id(= 에이전트 id).
// agentType·description은 패널 머리에 쓸 것 (호출 입력에서 화면이 이미 안다)
interface AgentRef {
    toolUseId?: string;
    agentId?: string;
    agentType?: string;
    description?: string;
}

type AgentViewResult =
    | {
          ok: true;
          agentId: string;
          status: "running" | "completed" | "failed" | "stopped" | "done";
          messages: LoadedMessage[];
          toolUses: number;
          tokens?: number;
          durationMs?: number;
      }
    | {ok: false; error: string; pending?: boolean};

// ── 지침 패널 (지침 | 기억) ──
// type: CLI가 주는 종류 — Project(CLAUDE.md·@import·.claude/rules), Local(CLAUDE.local.md), User(사용자 공통),
// Managed(관리 정책 — 읽기 전용), AutoMem(자동 메모리 목록 MEMORY.md)
interface InstructionFile {
    path: string;
    type: string;
    tokens: number;
}

// 대화 도중 불려 온 지침 (하위 폴더 CLAUDE.md, paths가 있는 규칙) — trigger = 그때 Claude가 다룬 파일
interface NestedInstruction {
    path: string;
    display: string;
    trigger?: string;
    at?: number;
}

// 기억 하나 = 기억 폴더의 파일 하나 (+ MEMORY.md 목록의 한 줄)
interface MemoryItem {
    path: string;
    file: string;
    title: string;
    hook: string;
    type?: string; // user | feedback | project | reference
    modified?: string;
    listed: boolean;
}

interface CreatableInstruction {
    kind: "user" | "project" | "local";
    path: string;
    gitIgnored?: boolean | null; // CLAUDE.local.md: git이 무시하는지 (null = 저장소 아님·모름)
}

type InstructionsList =
    | {
          ok: true;
          cwd: string;
          files: InstructionFile[];
          startTotal: number; // 새 대화를 시작하면 바로 쓰는 컨텍스트
          maxTokens: number;
          measuredAt: number;
          nested: NestedInstruction[];
          memoryDir: string | null;
          memories: MemoryItem[];
          creatable: CreatableInstruction[];
      }
    | {ok: false; error: string};

type InstructionRead =
    | {ok: true; exists: boolean; content: string; mtimeMs: number | null; readOnly: boolean}
    | {ok: false; error: string};

type InstructionWrite = {ok: true; mtimeMs: number} | {ok: false; conflict?: boolean; exists?: boolean; error?: string};

// ── 확장 창: 플러그인 (main의 plugins:*, claude plugin …) ──
// scope: user = 모든 프로젝트, project = 팀 공유(레포의 .claude/settings.json), local = 이 레포에서 나만(.claude/settings.local.json)
type PluginScope = "user" | "project" | "local";

interface InstalledPlugin {
    id: string; // 이름@마켓플레이스
    name: string;
    marketplace: string;
    version?: string;
    scope: string; // PluginScope 또는 managed(관리 정책)
    enabled: boolean; // 이 폴더에서 켜져 있다
    here: boolean; // 이 폴더에 적용된다 (사용자 범위, 또는 이 폴더가 그 레포 안) — 아니면 다른 레포에만 설치된 것
    projectPath?: string; // 레포 범위로 설치된 레포
    installedAt?: string;
    mcpServers: {name: string; transport: string; target?: string}[]; // transport: stdio(이 컴퓨터의 프로그램) | http | sse …
}

type PluginListResult =
    | {ok: true; cwd: string; projectRoot: string; home: string; configDir: string; plugins: InstalledPlugin[]}
    | {ok: false; error: string};

// claude plugin details — 안에 든 것과 대화마다 늘 드는 토큰(CLI의 어림값)
interface PluginDetails {
    description?: string;
    skills: string[];
    agents: string[];
    hooks: string[]; // 훅이 걸린 순간(SessionStart …)
    mcpServers: string[];
    lspServers: string[];
    alwaysOnTokens: number | null;
    components: {name: string; alwaysOn: string; onInvoke: string}[]; // 스킬·에이전트마다: 늘 드는 것 / 부를 때 드는 것
}

type PluginDetailsResult = {ok: true; details: PluginDetails} | {ok: false; error: string};

// 출처 — link가 있으면 브라우저로 연다(http(s)만). command = 명령 실행형 설치의 그 명령
interface PluginSource {
    kind: "repo" | "path" | "npm" | "command" | "other";
    text: string;
    link?: string;
    command?: string;
}

interface AvailablePlugin {
    id: string;
    name: string;
    description?: string;
    marketplace: string;
    version?: string;
    installCount: number | null; // 공식 디렉터리 일부만 있다
    source: PluginSource;
}

type PluginAvailableResult = {ok: true; plugins: AvailablePlugin[]; installed: string[]; fetchedAt: number} | {ok: false; error: string};

type PluginOp =
    | {kind: "install"; id: string; scope: PluginScope; acceptCommand?: string}
    | {kind: "enable"; id: string}
    | {kind: "disable" | "uninstall"; id: string; scope: PluginScope};

// confirm: 명령 실행형 설치 — 이 명령을 보여 주고, 사람이 확인하면 acceptCommand = sha256으로 다시 부른다
type PluginOpResult =
    | {ok: true; message: string; cliMessage?: string}
    | {
          ok: false;
          error: string;
          detail?: string;
          code?: string;
          busy?: boolean;
          cancelled?: boolean;
          confirm?: {command: string; mode?: string; sha256: string};
      };

// ── 확장 창: 대화 시작 비용 (main의 extensions:start_cost — getContextUsage("full")) ──
// categories.kind: used = 시작부터 컨텍스트에 든다, deferred = 필요할 때만 불러오는 도구(시작 비용 아님), buffer·free = 여유분
// skills.source: plugin | userSettings(내 스킬) | projectSettings(이 프로젝트) | built-in … — 플러그인 스킬은 "플러그인:스킬" 이름
interface StartCost {
    ok: true;
    cwd: string;
    model: string;
    total: number;
    max: number;
    measuredAt: number;
    full: boolean; // 토큰 세기 API로 셌다 (false = 어림값)
    mcpSettled: boolean; // MCP 서버 연결이 끝난 뒤 쟀다
    categories: {id?: string; name: string; tokens: number; kind: string}[];
    memoryFiles: {path: string; type: string; tokens: number}[];
    skills: {name: string; source: string; pluginName?: string; pluginId?: string; path?: string; tokens: number}[];
    mcpTools: {name: string; serverName: string; tokens: number; loaded: boolean}[]; // serverName은 정규화된 이름(plugin_figma_figma)
    mcpInstructions: {serverName: string; tokens: number}[];
    agents: {agentType: string; source: string; pluginId?: string; path?: string; tokens: number}[];
    mcpServers: {name: string; status: string; scope?: string}[]; // 잴 때의 MCP 상태 (plugin:figma:figma …)
}

type StartCostResult = StartCost | {ok: false; error: string};

// 대화 갈라지기 결과 — 새 세션을 새 탭으로 연다
type ForkResult = {ok: true; sessionId: string; title: string; cwd: string} | {ok: false; error: string};

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
    toolUseId?: string; // 이 작업을 띄운 도구 호출 (답변 속 그 줄)
    parentTaskId?: string; // 에이전트가 띄운 작업이면 그 에이전트의 작업 id
    usedTokens?: number; // 에이전트가 모델 호출에 쓴 토큰 합계 (입력·캐시·출력)
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
    terminated?: boolean; // 다른 명령(kill·pkill, dev 서버 다시 띄우기 …)이 신호로 끝냈다 — 실패가 아니라 "종료됨" (status는 stopped)
    hasOutput: boolean;
    recentTools?: ToolStep[];
    launchedByAgent?: boolean;
    toolUseId?: string;
    parentTaskId?: string;
    usedTokens?: number;
}

// 대화의 누적 토큰 (result.modelUsage 합 — 본 대화·에이전트·요약 등 모든 모델 호출)
interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
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
    image?: boolean; // 그림 파일 — images:read로 받아 그린다 (svg는 text도 온다)
    mime?: string;
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
    aliases?: string[]; // 같은 명령의 다른 이름 (/cost → /usage, /new → /clear) — "/" 없이
}

// ── 확장 창: 스킬 탭 (main/services/skills.ts와 같은 모양) ──
// scope: personal(~/.claude/skills) | project(<레포>/.claude/skills) | plugin | managed(관리자) | builtin(Claude Code에 들어 있음)
//        | synced(claude.ai에서 받음) | other
type SkillScope = "personal" | "project" | "plugin" | "managed" | "builtin" | "synced" | "other";

interface SkillEntry {
    id: string;
    name: string; // Claude가 부르는 이름 = /이름 (플러그인 스킬은 "플러그인:스킬")
    scope: SkillScope;
    legacy: boolean; // 옛 방식 .claude/commands/*.md
    plugin?: string;
    pluginId?: string;
    description: string;
    whenToUse?: string;
    argumentHint?: string;
    tokens: number | null; // 늘 컨텍스트에 들어가는 토큰 (null = 모름)
    manualOnly: boolean; // disable-model-invocation — 직접 부를 때만
    userInvocable: boolean; // false면 /이름으로 부를 수 없다
    paths?: string[]; // 맞는 파일을 다룰 때만 불려 온다
    path?: string;
    dir?: string;
    base?: string;
    editable: boolean;
    loaded: boolean; // CLI가 안다
}

type SkillProjectTarget =
    | {ok: true; dir: string; base: string; kind: "git" | "folder" | "worktree-main"}
    | {ok: false; reason: string};

type SkillsList =
    | {
          ok: true;
          cwd: string;
          skills: SkillEntry[];
          measured: boolean;
          measuredAt?: number;
          totalSkills?: number;
          includedSkills?: number;
          personalDir: string;
          project: SkillProjectTarget;
          takenNames: string[];
      }
    | {ok: false; error: string};

type SkillFileRead =
    | {ok: true; content: string; mtimeMs: number; readOnly: boolean; files?: {rel: string; size: number}[]; filesTruncated?: boolean}
    | {ok: false; error: string};

type SkillFileWrite = {ok: true; mtimeMs: number} | {ok: false; conflict?: boolean; exists?: boolean; error?: string};

interface SkillCreateRequest {
    scope: "personal" | "project";
    name: string;
    description: string;
    body: string;
    manualOnly: boolean;
}

type SkillCreateResult = {ok: true; path: string; name: string} | {ok: false; error: string};

// ── 확장 창: 훅 탭 (main/services/hooks.ts와 같은 모양) ──
// kind: user(개인 settings.json) | project(.claude/settings.json) | local(.claude/settings.local.json — 이 레포에서 나만)
//       | managed(관리자) | plugin | session(이 대화) | flag(실행 옵션) | other
type HookSourceKind = "user" | "project" | "local" | "managed" | "plugin" | "session" | "flag" | "other";

interface HookRow {
    event: string;
    matcher: string; // '' = 모든 경우
    source: string;
    kind: HookSourceKind;
    sourceLabel: string;
    plugin?: string; // 플러그인 id(이름@마켓플레이스)
    type: string; // command | prompt | agent | http | mcp_tool …
    text: string; // 실제로 도는 명령·프롬프트·URL
    statusMessage?: string;
    condition?: string;
    timeout?: number; // 초
    once?: boolean;
    async?: boolean;
    disabled?: boolean;
    file?: string;
}

interface HookEvent {
    name: string;
    summary: string;
    supportsMatcher: boolean;
    count: number;
}

type HooksList =
    | {
          ok: true;
          via: "cli" | "files"; // files = CLI에게 못 물어 설정 파일을 직접 읽었다
          cwd: string;
          events: HookEvent[];
          hooks: HookRow[];
          policy?: {allDisabled: boolean; disabledByPolicy: boolean; managedOnly: boolean; pluginOnly: boolean; policyUnreadable?: boolean};
          safeMode?: string;
          bareMode?: string;
          errors: string[];
          files: {kind: "user" | "project" | "local" | "managed"; path: string; exists: boolean}[];
          note?: string;
      }
    | {ok: false; error: string};

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
    customTitle?: string | null; // 사용자가 붙인 탭 이름 (탭을 더블클릭) — 있으면 자동 제목 대신 보인다
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

// Claude가 자동 메모리(기억)에 기억 하나를 저장했다 (Write·Edit 성공, 실시간만) — 기억 알림
interface MemorySavedEvent {
    path: string; // 기억 파일 (…/projects/<저장소>/memory/<이름>.md)
    name?: string; // frontmatter name
    description?: string; // frontmatter description — 무엇을 기억했는지
    updated: boolean; // 있던 기억을 고쳤다 (Edit, 또는 있던 파일 위에 Write)
}

// main이 탭마다 보내는 이벤트와 그 내용 (preload의 TAB_EVENTS와 같은 이름)
interface TabEventMap {
    chunk: string;
    thinking: string;
    done: undefined;
    error: ChatNoticeData;
    usage: {inputTokens: number; outputTokens: number};
    toolUse: {id: string; name: string; input: unknown; parentToolUseId?: string};
    toolResult: {id: string; isError: boolean; content: string; images?: string[]; parentToolUseId?: string};
    turnUuid: {uuid: string}; // 방금 보낸 사용자 메시지의 uuid (파일 되돌리기 기준점)
    turnStart: undefined; // 백그라운드 작업이 끝나 CLI가 스스로 시작한 턴
    permissionRequest: PermissionRequestData;
    questionRequest: {id: string; questions: AskQuestion[]}; // AskUserQuestion — 권한이 아니라 선택지 질문
    permissionResolved: {id: string | null}; // 더 이상 답할 수 없게 된 요청 (null이면 그 탭 전부)
    background: BackgroundState;
    cost: {totalCostUsd: number; usage?: TokenTotals};
    context: ContextUsage;
    commands: SlashCommand[];
    mcp: McpServer[];
    changedFiles: ChangedFilesState;
    session: {sessionId: string}; // 새 대화에 세션 ID가 정해졌다
    compact: CompactEvent; // 대화 압축 진행
    replyUuid: {uuid: string}; // 지금 답변의 마지막 기록 항목 (답변·도구 결과마다 갱신)
    suggestion: {text: string}; // 답변이 끝난 뒤 CLI가 짐작한 다음 요청 하나 (prompt_suggestion)
    instructions: Record<string, never>; // 지침·기억 파일이 바뀌었다 (앱에서 저장, Claude가 고침) — 다시 읽을 것
    memorySaved: MemorySavedEvent; // Claude가 기억 하나를 저장했다 — "클로드는 이것을 기억할 것입니다" 알림
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
        stopAllBackground: (tabId: string) => Promise<void>;
        rewindFiles: (tabId: string, uuid: string, dryRun: boolean) => Promise<RewindFilesResult>;
        forkConversation: (tabId: string, replyUuid: string) => Promise<ForkResult>;
        getAgentView: (tabId: string, ref: AgentRef) => Promise<AgentViewResult>;
        getPromptSuggestions: () => Promise<boolean>;
        setPromptSuggestions: (on: boolean) => Promise<boolean>;
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
        // HTML 미리보기: 코드 블록 글 → bc-preview:// 주소(너무 크면 null) / Claude가 만든 .html 파일 → 주소
        registerHtmlPreview: (html: string) => Promise<string | null>;
        previewFile: (tabId: string, path: string) => Promise<{ok: true; src: string; name: string} | {ok: false; error: string}>;
        // 지침 패널: 작업 폴더 줄의 크기 표시 / 목록 / 파일 읽기·저장 / 기억 지우기
        getInstructionsSummary: (tabId: string) => Promise<{count: number; tokens: number} | null>;
        listInstructions: (tabId: string, refresh?: boolean) => Promise<InstructionsList>;
        readInstruction: (tabId: string, path: string) => Promise<InstructionRead>;
        writeInstruction: (tabId: string, path: string, content: string, baseMtime: number | null, force?: boolean) => Promise<InstructionWrite>;
        deleteMemory: (tabId: string, path: string) => Promise<{ok: boolean; error?: string}>;
        resolveImages: (tabId: string, refs: ImageRef[]) => Promise<ResolvedImage[]>;
        readImage: (tabId: string, path: string) => Promise<string | null>;
        revealFile: (tabId: string, path: string) => Promise<void>;
        gitStatus: (tabId: string) => Promise<GitStatusResult>;
        gitDiff: (tabId: string, path: string) => Promise<GitDiffResult>;
        // refresh: 폴더 정보를 새로 받는다 (목록에 없는 명령을 쳤을 때 — 터미널에서 방금 설치한 플러그인 등)
        listCommands: (tabId: string, refresh?: boolean) => Promise<SlashCommand[]>;
        // 확장 창의 스킬 탭 — 목록 / 스킬 파일 읽기·저장 / 새 스킬 / Finder에서 보기 (경로는 main이 마지막 목록으로 검사)
        listSkills: (tabId: string, refresh?: boolean) => Promise<SkillsList>;
        readSkillFile: (tabId: string, path: string) => Promise<SkillFileRead>;
        writeSkillFile: (tabId: string, path: string, content: string, baseMtime: number | null, force?: boolean) => Promise<SkillFileWrite>;
        createSkill: (tabId: string, req: SkillCreateRequest) => Promise<SkillCreateResult>;
        revealSkill: (tabId: string, path: string) => Promise<boolean>;
        // 확장 창의 훅 탭 — 이 폴더에서 도는 훅 (읽기만) / 그 훅이 적힌 파일을 Finder에서 (마지막 목록에 낸 파일만)
        listHooks: (tabId: string) => Promise<HooksList>;
        revealHookFile: (tabId: string, path: string) => Promise<boolean>;
        getMcpStatus: (tabId: string, refresh?: boolean) => Promise<McpServer[]>;
        // MCP 서버 로그인 — 답은 로그인 주소를 연 뒤의 상태(waiting·claudeai·error), 이후 진행은 onMcpLogin
        mcpLogin: (tabId: string, name: string) => Promise<McpLoginState>;
        cancelMcpLogin: (name: string) => Promise<void>;
        getMcpLoginStates: () => Promise<McpLoginState[]>;
        onMcpLogin: (callback: (state: McpLoginState) => void) => () => void;
        // 목록을 못 받으면 null
        reconnectMcp: (tabId: string, name: string) => Promise<McpServer[] | null>;
        mcpLogout: (tabId: string, name: string) => Promise<McpLogoutResult>;

        // 확장 창의 플러그인 탭 — 목록·내용·찾아보기, 바꾸기(한 번에 하나), 진행 중인 것·취소
        listPlugins: (tabId: string) => Promise<PluginListResult>;
        getPluginDetails: (tabId: string, id: string) => Promise<PluginDetailsResult>;
        listAvailablePlugins: (tabId: string, refresh?: boolean) => Promise<PluginAvailableResult>;
        runPluginOp: (tabId: string, op: PluginOp) => Promise<PluginOpResult>;
        getPluginBusy: () => Promise<{kind: PluginOp["kind"]; id: string; startedAt: number} | null>;
        cancelPluginOp: () => Promise<void>;
        // 확장 창 "대화 시작 비용" — refresh면 다시 잰다 (CLI를 잠깐 띄운다, 대화 비용 없음)
        getStartCost: (tabId: string, refresh?: boolean) => Promise<StartCostResult>;

        getBackgroundOutput: (tabId: string, taskId: string, maxBytes?: number) => Promise<BackgroundOutput | null>;
        stopBackgroundTask: (tabId: string, taskId: string) => Promise<void>;
        clearFinishedBackground: (tabId: string) => Promise<void>;

        getPathForFile: (file: File) => string;
        getRateLimits: () => Promise<RateLimitWindow[]>;
        onRateLimits: (callback: (limits: RateLimitWindow[]) => void) => () => void;
        copyText: (text: string) => Promise<boolean>;
        writeClipboardImage: (dataUrl: string) => Promise<boolean>;
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
        getSessionStats: (sessionIds: string[]) => Promise<Record<string, {cost?: number; usage?: TokenTotals}>>;
        onSessionsChanged: (callback: () => void) => () => void;
        getClaudeStatus: () => Promise<{ found: boolean; path: string | null }>;
        locateClaude: () => Promise<
            | { ok: true; path: string }
            | { ok: false; cancelled?: boolean; error?: string }
        >;
        openClaudeInstallGuide: () => Promise<void>;
        onClaudeNotFound: (callback: () => void) => () => void;
    };
}
