import {protocol, session} from "electron";
import {createHash} from "crypto";
import fs from "fs";
import path from "path";

// HTML 미리보기 — 답변 속 HTML 코드 블록과 Claude가 만든 .html 파일을 앱과 격리된 곳에 그린다.
// 주소는 bc-preview://<id>/<경로>. 렌더러는 sandbox="allow-scripts" iframe으로 띄운다: allow-same-origin이 없어
// 출처가 앱과 달라 앱 화면·window.electronAPI에 닿지 못하고, preload는 하위 프레임에 들어가지 않는다.
// 응답마다 이 주소 전용 CSP를 붙인다(사용자가 고른 방침): 외부 라이브러리(https 스크립트·스타일·글꼴·그림)는
// 불러오되, fetch·XHR·WebSocket(connect-src)과 폼 전송은 막는다. 앱 화면 CSP에는 frame-src로 이 주소만 연다.

export const PREVIEW_SCHEME = "bc-preview";

const CSP = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
].join("; ");

// app ready 전에 불러야 한다 — standard라야 상대 경로가 풀리고 주소(id)마다 출처가 따로 생긴다.
// corsEnabled: 미리보기 칸은 출처가 없어서(sandbox) 같은 폴더의 모듈 스크립트(type="module")·웹 글꼴도 교차 출처 요청이
// 된다 — 이게 꺼져 있으면 그런 페이지가 빈 화면이었다(검토에서 찾음). 응답에 Access-Control-Allow-Origin도 붙인다.
// fetch·XHR은 CSP(connect-src 'none')가 그대로 막는다.
export function registerPreviewScheme() {
    protocol.registerSchemesAsPrivileged([
        {scheme: PREVIEW_SCHEME, privileges: {standard: true, secure: true, supportFetchAPI: false, corsEnabled: true, stream: true}},
    ]);
}

// 미리보기 쪽이 내용 높이를 알려 준다 — 답변 안 미리보기의 높이를 내용에 맞추려고(iframe은 출처가 달라 밖에서 못 잰다).
// 문서 전체 높이(documentElement.scrollHeight)는 창 높이 아래로 내려가지 않아 한번 커지면 줄지 않았다 — 본문 상자를 잰다.
const HEIGHT_REPORTER =
    "<script>(()=>{const post=()=>{const b=document.body;if(!b)return;const cs=getComputedStyle(b);" +
    "const h=b.getBoundingClientRect().height+parseFloat(cs.marginTop)+parseFloat(cs.marginBottom);" +
    "parent.postMessage({bcPreviewHeight:Math.ceil(Math.max(h,b.scrollHeight))},'*')};" +
    "const ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);" +
    "addEventListener('load',post);post();})();</script>";

// 미리보기 칸에서는 localStorage·sessionStorage를 읽기만 해도 오류가 난다(출처가 없는 sandbox) — 할 일 앱처럼 저장소를
// 쓰는 페이지는 스크립트가 첫 줄에서 멈춰 빈 화면이었다(검토에서 찾음). 그 칸 안에서만 쓰는 메모리 저장소로 바꿔 넣는다
// (다시 불러오면 비워진다). 페이지 스크립트보다 먼저 돌아야 해서 문서 맨 앞(<head> 바로 뒤)에 넣는다.
const STORAGE_SHIM =
    "<script>(()=>{const mk=()=>{const m=new Map();return{get length(){return m.size}," +
    "key(i){const k=[...m.keys()][i];return k===undefined?null:k},getItem(k){k=String(k);return m.has(k)?m.get(k):null}," +
    "setItem(k,v){m.set(String(k),String(v))},removeItem(k){m.delete(String(k))},clear(){m.clear()}}};" +
    "for(const n of['localStorage','sessionStorage']){try{window[n];continue}catch(e){}" +
    "try{Object.defineProperty(window,n,{value:mk(),configurable:true,enumerable:true})}catch(e){}}})();</script>";

// 저장소 대체는 맨 앞에, 높이 알림은 마지막 </body> 앞에 — 첫 </body>는 스크립트 문자열 속일 수 있다
// (document.write('…</body>')) — 거기 끼우면 그 스크립트가 끊겼다.
function withInjected(html: string): string {
    const lower = html.toLowerCase();
    const end = lower.lastIndexOf("</body");
    let out = end >= 0 ? html.slice(0, end) + HEIGHT_REPORTER + html.slice(end) : html + HEIGHT_REPORTER;
    const open = /<head(?:\s[^>]*)?>/i.exec(out) ?? /<html(?:\s[^>]*)?>/i.exec(out) ?? /^\s*<!doctype[^>]*>/i.exec(out);
    const at = open ? open.index + open[0].length : 0;
    out = out.slice(0, at) + STORAGE_SHIM + out.slice(at);
    return out;
}

// ── 등록된 미리보기 ──
// html = 코드 블록의 글 그대로(파일은 읽지 않는다), dir = Claude가 만든 HTML 파일의 폴더(그 폴더의 웹 파일만 내보낸다).
// dir의 allow = 그 탭에서 볼 수 있는 파일인가(작업 폴더 안이거나 Claude가 고친 파일) — 폴더 주소는 탭마다 따로다.
type Entry = {kind: "html"; html: string} | {kind: "dir"; root: string; allow: (rel: string) => boolean};
const entries = new Map<string, Entry>();
// 개수와 글자 수로 오래 안 쓴 것부터 버린다. 쓰일 때(내보낼 때)도 최근으로 올린다 — 예전에는 등록 순서로만 버려서,
// 받는 중인 HTML을 미리 보면 조각마다 새 주소가 쌓여 화면에 있는 다른 미리보기가 "찾을 수 없음"이 되었다.
const MAX_ENTRIES = 300;
const MAX_TOTAL_HTML = 64 * 1024 * 1024;
let totalHtml = 0;
export const MAX_PREVIEW_HTML = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 30 * 1024 * 1024;

function sizeOf(e: Entry): number {
    return e.kind === "html" ? e.html.length : 0;
}

function remember(id: string, entry: Entry) {
    const prev = entries.get(id);
    if (prev) {
        entries.delete(id);
        totalHtml -= sizeOf(prev);
    }
    entries.set(id, entry);
    totalHtml += sizeOf(entry);
    while (entries.size > MAX_ENTRIES || (totalHtml > MAX_TOTAL_HTML && entries.size > 1)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined || oldest === id) break;
        totalHtml -= sizeOf(entries.get(oldest) as Entry);
        entries.delete(oldest);
    }
}

function touch(id: string): Entry | undefined {
    const e = entries.get(id);
    if (e) {
        entries.delete(id);
        entries.set(id, e);
    }
    return e;
}

// 같은 내용이면 같은 id — 답변이 다시 그려져도 iframe이 다시 불러오지 않는다
function idFor(prefix: string, key: string): string {
    return prefix + createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function registerHtml(html: string): string {
    const id = idFor("h", html);
    remember(id, {kind: "html", html});
    return id;
}

export function registerDir(root: string, owner: string, allow: (rel: string) => boolean): string {
    const id = idFor("d", owner + "\u0000" + root);
    remember(id, {kind: "dir", root, allow});
    return id;
}

// 폴더 미리보기가 내보내는 파일 — 정적 웹 파일만. 숨김 파일(.env 등)과 그 밖의 형식은 내보내지 않는다.
const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
};

function isInside(root: string, p: string): boolean {
    return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function notFound(): Response {
    return new Response("미리보기를 찾을 수 없습니다", {status: 404, headers: {"Content-Type": "text/plain; charset=utf-8"}});
}

function respond(body: string | Buffer, type: string): Response {
    return new Response(body, {
        headers: {
            "Content-Type": type,
            "Content-Security-Policy": CSP,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

async function serveDir(entry: {root: string; allow: (rel: string) => boolean}, pathname: string): Promise<Response> {
    const {root} = entry;
    let rel: string;
    try {
        rel = decodeURIComponent(pathname);
    } catch {
        return notFound();
    }
    if (rel.split("/").some((seg) => seg.startsWith("."))) return notFound();
    if (!entry.allow(rel)) return notFound();
    const ext = path.extname(rel).toLowerCase();
    const type = MIME[ext];
    if (!type) return notFound();
    const target = path.resolve(root, "." + rel);
    if (!isInside(root, target)) return notFound();
    try {
        // 심볼릭 링크가 폴더 밖을 가리키면 내보내지 않는다
        const real = await fs.promises.realpath(target);
        if (!isInside(root, real)) return notFound();
        const st = await fs.promises.stat(real);
        if (!st.isFile() || st.size > MAX_ASSET_BYTES) return notFound();
        if (ext === ".html" || ext === ".htm") return respond(withInjected(await fs.promises.readFile(real, "utf8")), type);
        return respond(await fs.promises.readFile(real), type);
    } catch {
        return notFound();
    }
}

// app ready 뒤에 부른다
export function installPreviewProtocol() {
    protocol.handle(PREVIEW_SCHEME, async (request) => {
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return notFound();
        }
        const entry = touch(url.hostname);
        if (!entry) return notFound();
        if (entry.kind === "html") {
            if (url.pathname !== "/" && url.pathname !== "/index.html") return notFound();
            return respond(withInjected(entry.html), MIME[".html"]);
        }
        return serveDir(entry, url.pathname);
    });
    // 미리보기 칸(iframe)은 웹 페이지로 넘어가지 못한다 — 미리보기 속 페이지가 location을 바꾸면 그 칸에 아무 웹사이트나
    // 떴다(격리는 그대로지만 앱 화면 안에 외부 페이지가 보인다 — 재현됨). 앱 화면 CSP의 frame-src도, Electron의
    // will-frame-navigate도 칸이 스스로 시작한 이동은 잡지 못해서(실측) 요청 단계에서 끊는다. 앱에는 다른 iframe이 없다.
    // types로 칸 이동 요청만 받는다 — 그 밖의 요청(라이브러리, 개발 서버 모듈)까지 main을 거칠 필요가 없다.
    session.defaultSession.webRequest.onBeforeRequest({urls: ["http://*/*", "https://*/*"], types: ["subFrame"]}, (details, callback) => {
        callback(details.resourceType === "subFrame" ? {cancel: true} : {});
    });
}
