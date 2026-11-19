// Figma 층 — 도구 표(한국어 이름, 읽기·쓰기 구분)와 Figma 주소. main과 화면(도구 줄 꾸미기)이 같이 쓴다.
// DOM·Node에 기대지 않는 순수 함수만 둔다.
// MCP 도구 이름 자체(mcp__서버__도구)는 일반 층 shared/mcp-tools.ts가 읽는다.

// 원격 서버(mcp.figma.com — 플러그인·claude mcp add 둘 다)와 데스크톱 앱 서버. 이름에 figma가 들어간다.
export function isFigmaServer(server: string): boolean {
    return /figma/i.test(server);
}

// ── Figma 도구 ──
// read = Figma에서 읽는 도구 — 요금제 한도에 들어간다("Rate limits apply to tools that read data from Figma").
// write = 파일에 쓰는 도구 — 한도에서 빠진다(문서가 이름을 든 것: add_code_connect_map, create_new_file,
//   generate_figma_design, whoami. use_figma 등 나머지 쓰기 도구도 "write to Figma files"라 같이 뺀다 — 짐작).
// ai = Figma AI 크레딧을 쓴다(generate_image, generate_vector_illustration, send_prompt) — 호출 한도와 따로.
export type FigmaToolKind = "read" | "write" | "ai";

interface FigmaToolInfo {
    label: string;
    kind: FigmaToolKind;
    // 열 때 쓸 편집기 주소 — FigJam 도구는 board
    editor?: "board";
}

export const FIGMA_TOOLS: Record<string, FigmaToolInfo> = {
    get_design_context: {label: "디자인 정보 읽기", kind: "read"},
    get_screenshot: {label: "화면 캡처", kind: "read"},
    get_metadata: {label: "구조 읽기", kind: "read"},
    get_variable_defs: {label: "변수·토큰 읽기", kind: "read"},
    search_design_system: {label: "디자인 시스템 검색", kind: "read"},
    get_libraries: {label: "라이브러리 목록", kind: "read"},
    get_code_connect_map: {label: "코드 연결 읽기", kind: "read"},
    get_code_connect_suggestions: {label: "코드 연결 제안 받기", kind: "read"},
    get_context_for_code_connect: {label: "코드 연결용 정보 읽기", kind: "read"},
    get_figjam: {label: "FigJam 읽기", kind: "read", editor: "board"},
    get_motion_context: {label: "모션 정보 읽기", kind: "read"},
    get_comments: {label: "댓글 읽기", kind: "read"},
    get_shader: {label: "셰이더 읽기", kind: "read"},
    get_generative_plugin: {label: "생성 플러그인 읽기", kind: "read"},
    add_code_connect_map: {label: "코드 연결 추가", kind: "write"},
    send_code_connect_mappings: {label: "코드 연결 보내기", kind: "write"},
    use_figma: {label: "파일 수정", kind: "write"},
    generate_figma_design: {label: "디자인 만들기", kind: "write"},
    send_code_to_figma: {label: "코드를 Figma로 보내기", kind: "write"},
    generate_diagram: {label: "FigJam 다이어그램", kind: "write", editor: "board"},
    create_new_file: {label: "새 파일 만들기", kind: "write"},
    upload_assets: {label: "에셋 올리기", kind: "write"},
    create_shader: {label: "셰이더 만들기", kind: "write"},
    update_shader: {label: "셰이더 고치기", kind: "write"},
    create_generative_plugin: {label: "생성 플러그인 만들기", kind: "write"},
    update_generative_plugin: {label: "생성 플러그인 고치기", kind: "write"},
    create_session: {label: "작업 세션 시작", kind: "write"},
    whoami: {label: "계정 확인", kind: "write"},
    generate_image: {label: "이미지 생성", kind: "ai"},
    generate_vector_illustration: {label: "벡터 일러스트 생성", kind: "ai"},
    send_prompt: {label: "Make에 요청", kind: "ai"},
};

// 표에 없는 새 도구는 이름으로 짐작한다 — get_·search_로 시작하면 읽기
export function figmaToolInfo(tool: string): FigmaToolInfo {
    return FIGMA_TOOLS[tool] ?? {label: tool, kind: /^(get|search|list)_/.test(tool) ? "read" : "write"};
}

// ── Figma 주소 ──
// https://www.figma.com/design/<파일 키>/<이름>?node-id=42-100 (예전 /file/, FigJam /board/, /slides/, /proto/, /make/ …)
// 브랜치는 /design/<파일 키>/branch/<브랜치 키>/<이름> — 도구 호출에는 브랜치 키가 파일 키로 쓰인다.
export type FigmaEditor = "design" | "file" | "board" | "slides" | "deck" | "proto" | "make" | "site" | "buzz";

const EDITOR_LABEL: Record<FigmaEditor, string> = {
    design: "디자인",
    file: "디자인",
    board: "FigJam",
    slides: "슬라이드",
    deck: "슬라이드",
    proto: "프로토타입",
    make: "Make",
    site: "Sites",
    buzz: "Buzz",
};

export interface FigmaLink {
    url: string; // 찾은 주소 그대로 (끝 문장부호는 뗐다)
    editor: FigmaEditor;
    kindLabel: string; // 디자인 / FigJam / 슬라이드 / 프로토타입 …
    fileKey: string;
    name?: string; // 주소 속 이름 — 하이픈을 띄어쓰기로
    nodeId?: string; // "42:100" (주소에는 42-100)
}

const URL_RE =
    /https?:\/\/(?:www\.)?figma\.com\/(design|file|board|slides|deck|proto|make|site|buzz)\/([A-Za-z0-9]{6,})(?:\/branch\/([A-Za-z0-9]{6,}))?((?:\/[^\s?#()<>"'`\]]*)?)((?:\?[^\s#()<>"'`\]]*)?)(#[^\s()<>"'`\]]*)?/g;

function decodeSafe(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function toLink(m: RegExpExecArray): FigmaLink {
    const editor = m[1] as FigmaEditor;
    const slug = (m[4] ?? "").replace(/^\//, "").split("/")[0] ?? "";
    // 문장 끝 부호(마침표·쉼표 …)가 주소에 붙어 오는 일이 흔하다 — 떼고 쓴다
    let url = m[0];
    while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
    const query = (m[5] ?? "").replace(/[.,;:!?]+$/, "");
    const nodeParam = /[?&]node-id=([^&]+)/.exec(query)?.[1];
    const nodeId = nodeParam ? decodeSafe(nodeParam).replace(/-/g, ":") : undefined;
    const name = slug ? decodeSafe(slug).replace(/[.,;:!?]+$/, "").replace(/-/g, " ").trim() : "";
    return {
        url,
        editor,
        kindLabel: EDITOR_LABEL[editor],
        fileKey: m[3] ?? m[2],
        name: name || undefined,
        nodeId: nodeId && /^[\w:;-]+$/.test(nodeId) ? nodeId : undefined,
    };
}

// 글 속 Figma 파일 주소들 (같은 주소는 한 번) — 에셋 주소(figma.com/api/…)는 파일이 아니라 빠진다
export function figmaLinksIn(text: string, max = 8): FigmaLink[] {
    if (!text || !text.includes("figma.com/")) return [];
    const out: FigmaLink[] = [];
    const seen = new Set<string>();
    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(text); m && out.length < max; m = URL_RE.exec(text)) {
        const link = toLink(m);
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        out.push(link);
    }
    return out;
}

export function parseFigmaUrl(url: string): FigmaLink | null {
    return figmaLinksIn(url, 1)[0] ?? null;
}

// 파일 키(+노드)로 여는 주소. 노드 id "1:23" → node-id=1-23
export function figmaNodeUrl(fileKey: string, nodeId?: string, editor: "design" | "board" = "design"): string {
    const base = `https://www.figma.com/${editor}/${encodeURIComponent(fileKey)}`;
    return nodeId ? `${base}?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}` : base;
}
