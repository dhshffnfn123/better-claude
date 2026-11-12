import hljs from "highlight.js/lib/common";

// 문법 색상 — 파일 패널의 파일 보기와 채팅 코드 블록이 같이 쓴다.
// 색은 쓰는 쪽이 정한다: 파일 보기는 highlight.js의 github 테마(밝은 배경, FilesPanel.tsx에서 불러옴),
// 채팅 코드 블록은 chat.page.module.scss의 .codeBlock 아래에 둔 어두운 배경용 색.

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const LANG_BY_EXT: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", css: "css", scss: "scss", less: "less",
    html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
    swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
    sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
    sql: "sql", graphql: "graphql", lua: "lua", r: "r", pl: "perl", makefile: "makefile",
};

// 큰 코드는 색칠하지 않는다(화면이 멈추지 않게)
const FILE_MAX_CHARS = 400_000;
const AUTO_DETECT_MAX_CHARS = 50_000;
// 채팅 코드 블록은 답이 흘러 들어오는 동안 글자가 늘 때마다 다시 칠한다 — 더 작게 잡는다
const BLOCK_MAX_CHARS = 100_000;

// 파일 이름(확장자)으로 언어를 고르고, 모르면 짐작한다
export function highlightFile(text: string, filePath: string): string {
    if (text.length > FILE_MAX_CHARS) return escapeHtml(text);
    const name = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    const lang = LANG_BY_EXT[ext];
    try {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, {language: lang, ignoreIllegals: true}).value;
        if (text.length < AUTO_DETECT_MAX_CHARS) return hljs.highlightAuto(text).value;
    } catch {
        // 색칠에 실패하면 그냥 글자로
    }
    return escapeHtml(text);
}

// 코드 블록에 적힌 언어(```ts)로 칠한다. 언어가 없거나 모르는 언어면 그대로 둔다 —
// 명령 출력이나 일반 글에 짐작으로 색을 입히면 엉뚱하게 칠해지는 일이 잦다.
export function highlightLanguage(text: string, lang: string | undefined): string {
    if (!lang || text.length > BLOCK_MAX_CHARS) return escapeHtml(text);
    const name = lang.toLowerCase();
    try {
        if (hljs.getLanguage(name)) return hljs.highlight(text, {language: name, ignoreIllegals: true}).value;
    } catch {
        // 색칠에 실패하면 그냥 글자로
    }
    return escapeHtml(text);
}
