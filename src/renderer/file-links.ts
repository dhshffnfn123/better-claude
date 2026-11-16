// 답변 속 파일 경로 → JetBrains IDE로 열기 (main: editor:resolve / editor:open, src/main/services/jetbrains.ts)

// 문장 속 `코드`가 파일 경로처럼 보이는지: 확장자가 있는 이름(앞에 폴더 허용), 끝에 :줄(:칸)·:줄-줄 허용.
// 실제로 있는 파일인지는 main이 확인한다 — 여기서는 확인을 물어볼 만한 것만 고른다.
const PATH_RE =
    /^(?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}_.@()+-]+\/)*[\p{L}\p{N}_.@()+-]*[\p{L}\p{N}_)]\.[A-Za-z][\w]{0,9}(?::\d+(?::\d+)?(?:-\d+)?)?$/u;

export function looksLikeFilePath(text: string): boolean {
    return text.length <= 300 && PATH_RE.test(text);
}

// 마우스를 올릴 때마다 묻지 않게 잠깐 기억한다 (Claude가 방금 만든 파일도 곧 잡히도록 짧게)
const CACHE_MS = 10_000;
const cache = new Map<string, {at: number; result: Promise<EditorTarget>}>();

export function resolveFileRef(tabId: string, raw: string): Promise<EditorTarget> {
    const key = `${tabId}\n${raw}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
    const result = window.electronAPI.resolveEditorTarget(tabId, raw);
    cache.set(key, {at: Date.now(), result});
    return result;
}

export function openFileRef(tabId: string, raw: string): Promise<EditorTarget> {
    return window.electronAPI.openInEditor(tabId, raw);
}

// 툴팁 문구. withMeta: 문장 속 경로는 ⌘+클릭으로 연다(그냥 클릭은 글자 고르기에 쓰인다)
// (strict가 꺼져 있어 t.ok로는 타입이 좁혀지지 않는다 — ok === false로 가른다)
export function editorHint(t: EditorTarget, withMeta: boolean): string {
    if (t.ok === false) {
        if (t.reason === "no-ide") return "JetBrains IDE가 없어 열 수 없습니다";
        if (t.reason === "error") return `열지 못했습니다${t.message ? `: ${t.message}` : ""}`;
        return "파일을 찾을 수 없습니다";
    }
    return `${withMeta ? "⌘+클릭: " : ""}${t.app}에서 열기${t.line ? ` · ${t.line}번째 줄` : ""}`;
}
