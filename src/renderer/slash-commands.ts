import type {ChatNotice} from "./hooks/useClaudeChat";

// 입력창의 슬래시 명령 — 무엇은 CLI로 보내고, 무엇은 앱이 하고, 무엇은 터미널에서만 되는지.
// 목록과 실행은 CLI가 기준이다(main의 commands:list = SDK의 supportedCommands). 앱은 세 가지만 가로챈다:
//  - 앱에 같은 기능이 있는 것: CLI(SDK)에서는 "이번 프로세스만" 바뀌고 앱은 메시지마다 CLI를 새로 띄워서 다음 메시지에
//    사라지거나(/model, /effort), SDK에서 안 되거나(/fast "not available in the Agent SDK"), 화면이 따로 있는 것(/usage …)
//  - 터미널 화면에서만 되는 것: CLI가 "isn't available in this environment"라고만 답하거나(/plugin, /status, /login …)
//    터미널 화면의 일이라 앱에는 보이지 않는 것(/color, /focus — CLI 자신도 terminalOriented로 표시한다)
//  - 없는 명령(/install …): CLI는 모델에게 그대로 넘겨서 엉뚱한 답이 왔다
// 그 밖(스킬·/compact·/context·/rename·/goal …)은 그대로 보낸다 — 출력은 답변에 보인다.
// 컴포넌트 파일에서 컴포넌트가 아닌 것을 내보내면 Fast Refresh가 꺼져서 따로 둔다.

export type AppAction =
    | "new-conversation"
    | "model"
    | "effort"
    | "fast"
    | "settings"
    | "mcp"
    | "usage"
    | "guide"
    | "instructions"
    | "background"
    | "sessions";

// 앱이 처리할 명령 (탭 바깥 — 셸이 한다)
export interface AppCommand {
    action: AppAction;
    name: string; // 친 이름 (/cost처럼 별칭일 수 있다)
    args: string;
}

export type SlashResult =
    | {kind: "cli"} // 그대로 보낸다
    | {kind: "app"; command: AppCommand}
    | {kind: "notice"; notice: ChatNotice}
    | {kind: "unknown"; name: string; args: string}; // 목록에 없다 — 목록을 새로 받아 한 번 더 본 뒤 알린다(unknownNotice)

// "/" 메뉴의 한 줄 — CLI 목록 + 앱이 아는 명령. where: 앱이 처리 / 터미널에서만
export interface MenuCommand extends SlashCommand {
    where?: "app" | "terminal";
    note?: string; // 앱·터미널 명령의 설명 (CLI의 영어 설명 대신)
    extra?: boolean; // CLI 목록에는 없고 앱이 더한 줄
}

interface AppSpec {
    action: AppAction;
    note: string;
    argsToCli?: boolean; // 인자를 붙이면 CLI가 한다 (/config key=value, /mcp reconnect …)
}

const NEW_CONVERSATION: AppSpec = {action: "new-conversation", note: "이 탭에서 새 대화를 시작합니다 (지금 대화는 사이드바에 남습니다)"};
const SETTINGS: AppSpec = {action: "settings", note: "앱 설정을 엽니다 — key=value를 붙이면 CLI 설정을 바꿉니다", argsToCli: true};
const USAGE: AppSpec = {action: "usage", note: "탭별 토큰·비용을 엽니다 (요금제 한도는 작업 폴더 줄 오른쪽)"};
const BACKGROUND: AppSpec = {action: "background", note: "백그라운드 작업 패널을 엽니다"};

const APP_COMMANDS: Record<string, AppSpec> = {
    clear: NEW_CONVERSATION,
    reset: NEW_CONVERSATION,
    new: NEW_CONVERSATION,
    model: {action: "model", note: "이 탭의 모델을 바꿉니다 (opus·sonnet·haiku·fable 또는 모델 ID) — 위 모델 선택과 같습니다"},
    effort: {action: "effort", note: "이 탭의 effort를 바꿉니다 (low~max, ultracode on|off) — 위 effort 선택과 같습니다"},
    fast: {action: "fast", note: "이 탭의 Fast 모드를 켜고 끕니다 (on|off) — 위 ⚡ 버튼과 같습니다"},
    config: SETTINGS,
    settings: SETTINGS,
    mcp: {action: "mcp", note: "MCP 서버 상태를 엽니다 — reconnect·enable·disable을 붙이면 CLI가 합니다", argsToCli: true},
    usage: USAGE,
    cost: USAGE,
    stats: USAGE,
    help: {action: "guide", note: "사용 가이드를 엽니다"},
    memory: {action: "instructions", note: "지침·기억 패널을 엽니다 (CLAUDE.md, 자동 메모리)"},
    tasks: BACKGROUND,
    bashes: BACKGROUND,
    resume: {action: "sessions", note: "지난 대화 목록(사이드바)을 엽니다"},
};

// 터미널에서만 되는 것 — 보내지 않고 알린다. 값 = 앱에서 비슷한 일을 하는 곳 (없으면 "")
const TERMINAL_COMMANDS: Record<string, string> = {
    color: "입력줄 색은 터미널 화면의 것이라 앱에는 보이지 않습니다",
    focus: "터미널 화면 모드라 앱에는 없습니다",
    status: "앱에서는 모델·작업 폴더·사용량이 위쪽 막대에 보입니다",
    plugin: "", // pluginNotice
    login: "앱은 터미널과 같은 로그인을 씁니다 (터미널에서 claude 실행 후 /login)",
    logout: "앱은 터미널과 같은 로그인을 씁니다 (터미널에서 claude 실행 후 /logout)",
    permissions: "앱에서는 위쪽 방패 버튼으로 이 탭의 전체 허용·확인 모드를 바꿉니다",
    theme: "앱의 화면 테마는 위쪽 테마 버튼에서 바꿉니다",
    "add-dir": "앱에서는 작업 폴더 줄을 눌러 폴더를 바꿉니다 (새 대화로 시작)",
    rewind: "앱에서는 메시지 아래 \"파일 되돌리기\"·\"여기서 다시\"를 씁니다",
    exit: "탭을 닫으려면 ⌘W",
    quit: "탭을 닫으려면 ⌘W",
    export: "",
    hooks: "",
    keybindings: "",
    vim: "",
    "terminal-setup": "",
    statusline: "",
    ide: "",
    btw: "",
    "install-github-app": "",
    "release-notes": "",
    upgrade: "",
    feedback: "",
    bug: "",
    "privacy-settings": "",
};

// "/" 메뉴에 더하는 줄 — CLI 목록에 없는 것. 앱이 하는 것은 늘 보이고, 터미널 것은 글자를 하나라도 쳤을 때만
// (그냥 "/"만 친 목록이 길어지지 않게 — 정확히 친 이름이 다른 명령으로 바뀌지 않게 하려는 줄이다).
const EXTRA_APP = ["help", "memory", "tasks", "resume"];
const EXTRA_TERMINAL = [
    "plugin",
    "status",
    "login",
    "logout",
    "permissions",
    "theme",
    "add-dir",
    "rewind",
    "export",
    "hooks",
    "exit",
];

// 파일 경로로 흔히 쓰는 첫 단어 — "/tmp 정리해 줘"는 명령이 아니다
const ROOT_DIRS = new Set(["tmp", "etc", "usr", "var", "opt", "bin", "sbin", "dev", "home", "private", "proc", "mnt", "srv", "root", "lib", "cores", "nix"]);

// 맨 앞 "/이름"과 나머지. 이름처럼 생기지 않았으면(경로 "/Users/a", 대문자, 빈 이름) null — 그냥 글로 보낸다.
// 맨 앞이 공백이면 명령으로 보지 않는다(CLI에 글 그대로 보내고 싶을 때의 탈출구).
export function parseSlash(raw: string): {name: string; args: string} | null {
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw.replace(/\s+$/, ""));
    if (!m) return null;
    const name = m[1];
    if (!/^[a-z0-9_][a-z0-9_:.-]*$/.test(name) || ROOT_DIRS.has(name)) return null;
    return {name, args: (m[2] ?? "").trim()};
}

function findCli(name: string, commands: SlashCommand[]): SlashCommand | undefined {
    const key = "/" + name.toLowerCase();
    return commands.find((c) => c.name.toLowerCase() === key || c.aliases?.some((a) => "/" + a.toLowerCase() === key));
}

// 보낼 글을 보고 할 일을 정한다. commands = CLI 목록(비어 있으면 아직 못 받았다 — 모르는 명령도 그대로 보낸다)
export function classifySlash(raw: string, commands: SlashCommand[]): SlashResult {
    const parsed = parseSlash(raw);
    if (!parsed) return {kind: "cli"};
    const {name, args} = parsed;
    const cli = findCli(name, commands);
    // 같은 이름의 사용자·플러그인 명령이 있으면(터미널 전용 내장 명령과 겹칠 때) 그게 CLI에서 돈다
    if (cli?.source === "custom") return {kind: "cli"};
    const app = APP_COMMANDS[name];
    if (app && !(app.argsToCli && args)) return {kind: "app", command: {action: app.action, name, args}};
    if (name in TERMINAL_COMMANDS) return {kind: "notice", notice: terminalNotice(name, args)};
    if (cli || commands.length === 0) return {kind: "cli"};
    return {kind: "unknown", name, args};
}

function terminalNotice(name: string, args: string): ChatNotice {
    if (name === "plugin") return pluginNotice(args);
    const hint = TERMINAL_COMMANDS[name];
    return {
        level: "warning",
        message: `/${name} 명령은 터미널의 claude에서만 쓸 수 있습니다${hint ? ` — ${hint}` : ""}`,
    };
}

// 플러그인 관리는 터미널 화면(/plugin)이나 셸 명령(claude plugin …)으로만 된다 — 셸에서 칠 명령을 그대로 보여 준다
// (알림은 글자 그대로 그려서 코드 표시(`) 없이 쌍점 뒤에 둔다 — 그대로 골라 복사할 수 있게)
function pluginNotice(args: string, install = false): ChatNotice {
    const shell = args ? `claude plugin ${args}` : "claude plugin install <플러그인>@<마켓플레이스>";
    return {
        level: "warning",
        message: `플러그인 설치·관리는 터미널에서 합니다 — 셸에서: ${shell}`,
        detail:
            "터미널에서 claude를 실행해 /plugin으로 고르거나, 셸에서 claude plugin install·uninstall·enable·disable·marketplace add를 씁니다.\n" +
            "설치한 플러그인의 명령은 다음 메시지부터 쓸 수 있습니다." +
            (install ? "\nGitHub 앱 설치(/install-github-app)와 Claude Code 자체 설치(claude install)도 터미널에서 합니다." : ""),
    };
}

// 목록을 새로 받아도 없는 명령
export function unknownNotice(name: string, args: string): ChatNotice {
    if (name === "install" || name === "plugins") return pluginNotice(args ? `install ${args}` : "", true);
    return {
        level: "warning",
        message: `/${name} 명령은 없습니다 — "/"를 치면 이 폴더에서 쓸 수 있는 명령이 보입니다`,
        detail:
            "CLI는 모르는 명령을 Claude에게 글로 넘기는데, 그러면 명령이 실행된 것처럼 보이지 않아 앱이 보내지 않았습니다.\n" +
            "이 글을 Claude에게 그대로 보내려면 맨 앞에 공백을 하나 넣어 보내세요.",
    };
}

// "/" 메뉴: CLI 목록에 앱·터미널 표시와 설명을 붙이고, CLI 목록에 없는 앱·터미널 명령을 더한다
export function menuCommands(commands: SlashCommand[]): MenuCommand[] {
    const out: MenuCommand[] = commands.map((c) => {
        if (c.source === "custom") return c;
        const name = c.name.slice(1);
        const app = APP_COMMANDS[name];
        if (app) return {...c, where: "app", note: app.note};
        if (name in TERMINAL_COMMANDS) return {...c, where: "terminal", note: TERMINAL_COMMANDS[name] || undefined};
        return c;
    });
    const have = new Set(out.map((c) => c.name));
    for (const name of EXTRA_APP) {
        if (have.has("/" + name)) continue;
        out.push({name: "/" + name, description: "", source: "builtin", where: "app", note: APP_COMMANDS[name].note, extra: true});
    }
    for (const name of EXTRA_TERMINAL) {
        if (have.has("/" + name)) continue;
        const hint = TERMINAL_COMMANDS[name];
        out.push({
            name: "/" + name,
            description: "",
            source: "builtin",
            where: "terminal",
            note: name === "plugin" ? "플러그인 설치·관리 — 셸의 claude plugin install …" : hint || "터미널의 claude에서만 됩니다",
            extra: true,
        });
    }
    return out;
}

// 친 글(q = "/us")에 맞는 메뉴 줄. 정확히 같은 이름이 맨 위, 그다음은 사용자 명령 먼저·짧은 이름 먼저 — 예전에는 CLI
// 목록 순서 그대로라 "/usage"·"/us"에서 Enter를 누르면 앞에 있던 /usage-credits가 실행됐고(브라우저가 열린다, 실제로
// 겪음), "/plugin"은 /plugin-authoring 스킬이 돌았다. "/"만 쳤을 때는 CLI 순서 그대로 둔다.
export function filterMenu(list: MenuCommand[], typed: string): MenuCommand[] {
    const q = typed.toLowerCase();
    const hits = list.filter((c) => c.name.toLowerCase().startsWith(q) && !(c.extra && c.where === "terminal" && q.length < 2));
    if (q.length < 2) return hits;
    const rank = (c: MenuCommand) => (c.name.toLowerCase() === q ? 0 : c.source === "custom" ? 1 : 2);
    return hits.map((c, i) => ({c, i})).sort((a, b) => rank(a.c) - rank(b.c) || a.c.name.length - b.c.name.length || a.i - b.i).map((x) => x.c);
}
