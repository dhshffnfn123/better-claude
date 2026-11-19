// MCP 서버 로그인(OAuth) 보조 — main.ts의 "MCP 서버 로그인"이 쓴다.
//
// SDK의 Query에는 sdk.d.ts에 선언되지 않은 메서드가 sdk.mjs에 있다(SDK 0.3.319 확인). 모두 CLI control request다:
//   mcpAuthenticate(serverName, redirectUri?, {redirectUriOnly?}) → mcp_authenticate
//   mcpClearAuth(serverName)                                     → mcp_clear_auth
//   mcpSubmitOAuthCallbackUrl(serverName, callbackUrl)           → mcp_oauth_callback_url
// 선언이 없어 좁은 타입을 따로 두고, 부르기 전에 typeof로 확인한다(없는 버전이면 터미널 안내로 대신한다).

// mcp_authenticate의 답 (CLI 2.1.325 실측)
//   보통 HTTP/SSE 서버: {authUrl, requiresUserAction: true, callbackExpected: true, redirectScheme: "localhost", state, callbackPort}
//   claude.ai 커넥터:    {authUrl, requiresUserAction: true, callbackExpected: false} — 연결은 claude.ai에서 끝난다
//   사용자 확인 없이 끝남: {requiresUserAction: false, callbackExpected: false}
export interface McpAuthReply {
    authUrl?: string;
    requiresUserAction?: boolean;
    callbackExpected?: boolean;
    redirectScheme?: string;
    callbackPort?: number;
}

export interface McpAuthMethods {
    mcpAuthenticate?: (serverName: string, redirectUri?: string, opts?: {redirectUriOnly?: boolean}) => Promise<McpAuthReply>;
    mcpClearAuth?: (serverName: string) => Promise<unknown>;
    mcpSubmitOAuthCallbackUrl?: (serverName: string, callbackUrl: string) => Promise<unknown>;
}

// 브라우저로 여는 로그인 주소는 https만, http는 이 컴퓨터(루프백) 주소만 — 로컬 테스트 서버용. 그 밖(file:, 앱 스킴 등)은 열지 않는다.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isOpenableAuthUrl(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

// 앱에서 로그인할 수 없을 때(이 SDK·CLI가 기능을 모른다) 예전처럼 터미널로 안내한다
export const TERMINAL_LOGIN_HINT = "터미널에서 claude를 실행해 /mcp로 인증한 뒤, 위의 ↻로 다시 확인하세요.";

export interface McpLoginError {
    error: string; // 줄에 보이는 짧은 한국어
    detail?: string; // CLI가 보낸 원문 (마우스를 올리면 보인다)
    unavailable?: boolean; // 앱에서는 안 된다 — 터미널 안내를 보인다
}

// CLI의 오류 문구 → 짧은 한국어. 문구는 CLI 2.1.325의 mcp_authenticate·mcp_clear_auth 처리에서 확인했다.
// 모르는 문구는 CLI 원문을 그대로 보인다.
const KNOWN_ERRORS: [RegExp, string][] = [
    [/^Server not found:/i, "이 작업 폴더의 설정에서 서버를 찾지 못했습니다 — ↻로 다시 확인하세요"],
    [/blocked by (enterprise )?managed policy/i, "회사 관리 정책이 막아 둔 서버입니다"],
    [/\bis disabled\b/i, "꺼져 있습니다 — 터미널에서 /mcp로 켤 수 있습니다"],
    [/not approved for this project/i, "이 프로젝트에서 아직 승인하지 않은 서버입니다 — 터미널에서 /mcp로 승인하세요"],
    [/^Server type "([^"]*)" does not support OAuth/i, "로그인(OAuth)을 쓰지 않는 서버입니다 ($1)"],
    [/^Cannot clear auth for server type "([^"]*)"/i, "앱에서 로그아웃할 수 없는 서버입니다 ($1)"],
    [/claude\.ai connector auth URL/i, "claude.ai 커넥터 주소를 만들지 못했습니다 — claude.ai 설정 → 커넥터에서 연결하세요"],
    [/provided to this session by Claude Code's cloud service/i, "Claude Code 클라우드가 로그인을 맡는 서버입니다 — claude.ai 설정 → 커넥터에서 연결하세요"],
    [/Claude account changed while sign-in/i, "로그인을 준비하는 사이 Claude 계정이 바뀌었습니다 — 다시 시도하세요"],
    [/callback port (\d+) is already in use/i, "로그인 콜백 포트 $1을 다른 프로그램이 쓰고 있습니다"],
    [/Authentication timeout/i, "5분 안에 로그인을 마치지 않아 취소했습니다"],
];

export function explainMcpLoginError(raw: string): McpLoginError {
    const text = raw.trim();
    for (const [re, ko] of KNOWN_ERRORS) {
        const m = re.exec(text);
        if (m) return {error: ko.replace("$1", m[1] ?? ""), detail: text};
    }
    // 이 CLI가 control request 자체를 모른다 — 앱에서는 할 수 없다
    if (/Unsupported control request/i.test(text)) return {error: TERMINAL_LOGIN_HINT, detail: text, unavailable: true};
    return {error: text || "알 수 없는 오류로 실패했습니다"};
}
