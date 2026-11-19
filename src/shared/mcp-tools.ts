// MCP 도구 이름 — 어느 서버에도 기대지 않는 일반 층. main과 화면이 같이 쓴다(DOM·Node에 기대지 않는 순수 함수).
// 특정 서버를 꾸미는 일(Figma 한국어 이름 등)은 화면 쪽 꾸미기 층(renderer/mcp-tool-display.ts에 등록)이 한다.

// CLI는 MCP 도구를 mcp__<서버>__<도구>로 부른다. 서버 이름의 [a-zA-Z0-9_-] 밖 글자는 _로 바뀐다 —
// 플러그인 서버 "plugin:figma:figma"는 plugin_figma_figma. 서버 이름에 __가 있으면 CLI도 첫 __에서 가른다.
export interface McpToolName {
    server: string; // 바뀐 서버 이름 그대로 (plugin_figma_figma)
    tool: string;
}

export function parseMcpToolName(name: string): McpToolName | null {
    if (!name.startsWith("mcp__")) return null;
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    if (i <= 0 || i + 2 >= rest.length) return null;
    return {server: rest.slice(0, i), tool: rest.slice(i + 2)};
}

// 화면에 쓰는 서버 이름 — plugin_<플러그인>_<서버>에서 둘이 같으면 하나만 (plugin_figma_figma → figma).
// 이름 안에도 _가 있을 수 있어 앞뒤가 같은 지점을 찾고, 없으면 plugin_만 뗀다 (plugin_acme_tools → acme_tools).
export function mcpServerLabel(server: string): string {
    const m = /^plugin_(.+)$/.exec(server);
    if (!m) return server;
    const rest = m[1];
    for (let i = 1; i < rest.length - 1; i++) {
        if (rest[i] === "_" && rest.slice(0, i) === rest.slice(i + 1)) return rest.slice(0, i);
    }
    return rest;
}

// 도구 줄 뒤에 흐리게 붙일 입력 요약 — 사람이 알아볼 만한 값(검색어·주소·경로·이름·제목 …)을 먼저, 없으면 첫 짧은 글.
// 코드·긴 본문(여러 줄 스크립트 등)은 요약이 아니라서 건너뛴다.
const SUMMARY_KEYS = ["query", "q", "url", "path", "file_path", "filePath", "name", "title", "fileName", "description", "prompt", "id"];
const SUMMARY_MAX = 300;

function oneLine(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || t.length > SUMMARY_MAX * 3 || t.split("\n").length > 3) return null;
    return t.replace(/\s+/g, " ").slice(0, SUMMARY_MAX);
}

export function mcpInputSummary(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const obj = input as Record<string, unknown>;
    for (const k of SUMMARY_KEYS) {
        const s = oneLine(obj[k]);
        if (s) return s;
    }
    for (const v of Object.values(obj)) {
        const s = oneLine(v);
        if (s) return s;
    }
    return "";
}
