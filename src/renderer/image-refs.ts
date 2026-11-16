// 답변 속 그림 — 글·도구 입출력에 나온 그림 파일 경로를 찾고, main(images:resolve)에 있는지 확인받는다.
// 실제로 있는 그림인지(확장자 + 파일 앞부분)는 main이 본다 — 여기서는 물어볼 만한 것만 고른다.

const IMAGE_EXTS = "png|jpe?g|gif|webp|svg|bmp|ico|avif";
const IMAGE_END_RE = new RegExp(`\\.(?:${IMAGE_EXTS})$`, "i");
// http:, data:, file: 같은 주소와 //로 시작하는 주소는 파일 경로가 아니다
const SCHEME_RE = /^(?:[a-z][\w+.-]*:|\/\/)/i;

export function isImagePath(s: string): boolean {
    const t = s.trim();
    return t.length > 4 && t.length <= 400 && IMAGE_END_RE.test(t) && !SCHEME_RE.test(t) && !t.includes("*");
}

// 마크다운 링크·그림: [글](주소), ![글](주소) — 주소 뒤의 "제목"은 건너뛴다
const LINK_RE = /(!?)\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/g;
// 문장 속 `코드`
const CODE_SPAN_RE = /`([^`\n]+)`/g;
// 그냥 적힌 경로: 공백·따옴표·괄호 뒤에서 시작해 그림 확장자로 끝나는 토큰. 경로 뒤에 한국어 조사가
// 바로 붙어도 된다("chart.png에 저장") — 확장자 뒤에 영문·숫자만 오지 않으면 된다.
const BARE_RE = new RegExp(
    `(?:^|(?<=[\\s\`'"(\\[<:=]))((?:~|\\.{1,2})?\\/?(?:[\\p{L}\\p{N}_.@+-]+\\/)*[\\p{L}\\p{N}_.@+-]*[\\p{L}\\p{N}_]\\.(?:${IMAGE_EXTS}))(?![A-Za-z0-9_])`,
    "giu"
);
// 코드 블록 속 경로는 코드다(savefig("chart.png") 등) — 빼고 찾는다
const FENCE_RE = /(^|\n) {0,3}(```|~~~)[\s\S]*?(\n {0,3}\2|$)/g;

// mentioned: 글에 나온 그림 경로, embedded: 마크다운 그림 문법(![](…))으로 그 자리에 그려질 것
export function imageRefsInText(md: string): {mentioned: string[]; embedded: string[]} {
    const text = md.replace(FENCE_RE, "\n");
    const embedded = new Set<string>();
    const mentioned = new Set<string>();
    for (const m of text.matchAll(LINK_RE)) {
        if (!isImagePath(m[2])) continue;
        (m[1] ? embedded : mentioned).add(m[2]);
    }
    for (const m of text.matchAll(CODE_SPAN_RE)) {
        if (isImagePath(m[1])) mentioned.add(m[1].trim());
    }
    // 코드 표기·링크는 위에서 통째로 잡았다 — 빼고 문장에서만 찾아야 "차트 1.png"의 "1.png"가 따로 잡히지 않는다
    const prose = text.replace(CODE_SPAN_RE, " ").replace(LINK_RE, " ");
    for (const m of prose.matchAll(BARE_RE)) {
        if (isImagePath(m[1])) mentioned.add(m[1]);
    }
    for (const e of embedded) mentioned.delete(e);
    return {mentioned: [...mentioned], embedded: [...embedded]};
}

export function imageRefKey(r: ImageRef): string {
    return `${r.ref}\u0000${r.since ?? ""}\u0000${r.infoOnly ? 1 : 0}`;
}

// 같은 그림을 답변이 다시 그려질 때마다 묻지 않게 잠깐 기억한다. 못 찾은 결과는 기억하지 않는다 —
// Claude가 "chart.png를 만들겠습니다"라고 쓴 뒤에 파일이 생기는 일이 흔하다.
const CACHE_MS = 20_000;
const cache = new Map<string, {at: number; result: ResolvedImage}>();

export async function resolveImageRefs(tabId: string, refs: ImageRef[]): Promise<Map<string, ResolvedImage>> {
    const out = new Map<string, ResolvedImage>();
    const missing: ImageRef[] = [];
    const now = Date.now();
    for (const r of refs) {
        const key = `${tabId}\u0001${imageRefKey(r)}`;
        const hit = cache.get(key);
        if (hit && now - hit.at < CACHE_MS) out.set(imageRefKey(r), hit.result);
        else if (!missing.some((m) => imageRefKey(m) === imageRefKey(r))) missing.push(r);
    }
    // main은 한 번에 24개까지 받는다
    for (let i = 0; i < missing.length; i += 24) {
        const batch = missing.slice(i, i + 24);
        const results = await window.electronAPI.resolveImages(tabId, batch).catch(() => [] as ResolvedImage[]);
        results.forEach((res, j) => {
            const key = imageRefKey(batch[j]);
            out.set(key, res);
            if (res.ok) cache.set(`${tabId}\u0001${key}`, {at: Date.now(), result: res});
        });
    }
    if (cache.size > 400) {
        for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
    }
    return out;
}
