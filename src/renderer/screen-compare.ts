// 화면 대조(ScreenComparePanel)가 쓰는 것 — 대화 속 디자인 그림 찾기, 디자인 크기로 찍을 창 크기 짐작, dev 서버 출력에서
// 이 컴퓨터 주소 찾기, Claude에게 붙일 그림 만들기, 탭마다 패널 상태(닫았다 열어도 그대로).
// 컴포넌트 파일에서 컴포넌트가 아닌 것을 내보내면 Fast Refresh가 꺼져서 따로 둔다.
import {useEffect, useState} from "react";
import type {ImagePayload, Message} from "./hooks/useClaudeChat";
import {figmaLinksIn, isFigmaServer} from "../shared/figma";
import {parseMcpToolName} from "../shared/mcp-tools";
import {toolImageName} from "./mcp-tool-display";
import {terminalText} from "./terminal-text";

// ── 디자인 그림 ──
export interface DesignImage {
    src: string; // data URL (도구 결과·붙여 넣은 그림) 또는 object URL
    name: string; // "Shop App · 노드 12:34" / "Figma 노드 12:34" / 파일 이름
    figma: boolean; // Figma 도구가 돌려준 그림
    nodeId?: string;
    at?: number; // 찍은 시각 (도구를 부른 시각)
}

// 패널을 열 때 넘기는 것 — 없는 것은 패널이 알아서 채운다(대화의 마지막 Figma 캡처, 실행 중인 dev 서버 주소)
export interface CompareRequest {
    design?: DesignImage;
    url?: string;
    capture?: boolean; // 열자마자 찍는다 ([화면 찍기])
}

function str(v: unknown): string | undefined {
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Figma 도구가 돌려준 그림이면 디자인으로 — 답변 속 그림 줄의 "구현과 비교"
export function figmaDesignOf(tool: {name: string; input: unknown; startedAt?: number}, src: string, fileName?: string): DesignImage | undefined {
    const mcp = parseMcpToolName(tool.name);
    if (!mcp || !isFigmaServer(mcp.server)) return undefined;
    const nodeId = str((tool.input as {nodeId?: unknown} | null)?.nodeId);
    return {src, name: `${fileName || "Figma"} · ${nodeId ? `노드 ${nodeId}` : "화면 캡처"}`, figma: true, nodeId, at: tool.startedAt};
}

// 대화에 나온 그림 — 최근 것부터. Figma 도구가 돌려준 그림(화면 캡처)이 디자인 후보다. 내가 붙인 그림도 고를 수 있다.
export function conversationImages(messages: Message[]): DesignImage[] {
    // 노드 번호 → Figma 파일 이름 (내가 보낸 Figma 링크에서 — "Shop App · 노드 12:34")
    const fileNames = new Map<string, string>();
    for (const m of messages) {
        if (m.role !== "user") continue;
        for (const l of figmaLinksIn(m.content)) if (l.nodeId && l.name) fileNames.set(l.nodeId, l.name);
    }
    const out: DesignImage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "user") {
            (m.images ?? []).forEach((src) => out.push({src, name: "내가 붙인 그림", figma: false}));
            continue;
        }
        const segs = m.segments ?? [];
        for (let j = segs.length - 1; j >= 0; j--) {
            const sg = segs[j];
            if (sg.kind !== "tool" || !sg.tool.images?.length) continue;
            const tool = sg.tool;
            const input = (tool.input ?? {}) as Record<string, unknown>;
            const nodeId = str(input.nodeId);
            const fp = str(input.file_path);
            const plainName = fp ? fp.slice(fp.lastIndexOf("/") + 1) : toolImageName(tool.name, tool.input);
            tool.images.forEach((src) =>
                out.push(figmaDesignOf(tool, src, nodeId ? fileNames.get(nodeId) : undefined) ?? {src, name: plainName, figma: false, at: tool.startedAt})
            );
        }
    }
    return out;
}

// ── 찍을 창 크기 ──
// 디자인 그림은 흔히 2배(레티나)·3배(모바일)로 뽑힌다 — 흔한 화면 너비로 나눠떨어지는 배율을 고른다.
const COMMON_WIDTHS = [
    320, 360, 375, 390, 393, 402, 412, 414, 428, 430, 440, 600, 768, 800, 810, 820, 834, 1024, 1080, 1180, 1194, 1200, 1280, 1366, 1440,
    1512, 1536, 1600, 1680, 1728, 1920,
];

export function guessScale(pxWidth: number): number {
    if (COMMON_WIDTHS.includes(pxWidth)) return 1;
    if (COMMON_WIDTHS.includes(pxWidth / 2)) return 2;
    if (COMMON_WIDTHS.includes(pxWidth / 3)) return 3;
    return pxWidth > 1920 ? 2 : 1;
}

// 디자인 크기 → 찍을 창(CSS 픽셀). 아주 긴 디자인(페이지 전체를 그린 프레임)은 보통 창 높이로 열고 페이지 끝까지 찍는다.
export function designViewport(pxWidth: number, pxHeight: number): {width: number; height: number; fullPage: boolean; scale: number} {
    const scale = guessScale(pxWidth);
    const width = Math.round(pxWidth / scale);
    const height = Math.round(pxHeight / scale);
    if (height > 1400) return {width, height: Math.min(900, height), fullPage: true, scale};
    return {width, height, fullPage: false, scale};
}

// ── dev 서버 출력에서 이 컴퓨터 주소 ──
// Vite는 주소 가운데에 색 코드를 끼운다("http://localhost:\e[1m5173\e[22m/") — 터미널 제어 문자(색·링크 …)를 먼저 뺀다
// (terminal-text.ts, 백그라운드 로그와 같은 것). 0.0.0.0(모든 주소에서 받음)은 localhost로.
const LOOPBACK_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>`)\]]*)?/gi;

export function loopbackUrlsIn(text: string): string[] {
    const plain = terminalText(text);
    const out: string[] = [];
    for (const m of plain.matchAll(LOOPBACK_RE)) {
        const url = m[0].replace(/[.,;:!?]+$/, "").replace("://0.0.0.0", "://localhost");
        if (!out.includes(url)) out.push(url);
    }
    return out;
}

// 셸 작업마다 찾은 주소 (작업 줄 카드·백그라운드 패널·화면 대조가 같이 본다). 한 번 찾으면 더 읽지 않는다.
// 서버가 아닌 작업(테스트 감시 등)은 주소가 끝내 안 나온다 — 2분쯤 찾다 그만둔다.
const urlByTask = new Map<string, string>();
const URL_POLL_MS = 3000;
const URL_POLL_MAX = 40;
const URL_READ_BYTES = 60_000;

async function readTaskUrl(tabId: string, taskId: string): Promise<string | null> {
    const hit = urlByTask.get(taskId);
    if (hit) return hit;
    const out = await window.electronAPI.getBackgroundOutput(tabId, taskId, URL_READ_BYTES).catch(() => null);
    // 마지막에 나온 주소 — dev 서버를 다시 띄우면 새 포트가 뒤에 찍힌다
    const urls = out ? loopbackUrlsIn(out.text) : [];
    const url = urls[urls.length - 1] ?? null;
    if (url) urlByTask.set(taskId, url);
    return url;
}

// 실행 중인 셸 작업의 출력에 나온 이 컴퓨터 주소 — 찾을 때까지 몇 초마다 다시 읽는다 (보이는 탭에서만)
export function useTaskUrl(tabId: string, task: {id: string; type: string; hasOutput?: boolean} | null, enabled: boolean): string | null {
    const taskId = task && task.type === "local_bash" && task.hasOutput ? task.id : null;
    const [url, setUrl] = useState<string | null>(() => (taskId ? urlByTask.get(taskId) ?? null : null));
    useEffect(() => {
        if (!taskId) {
            setUrl(null);
            return;
        }
        const known = urlByTask.get(taskId);
        setUrl(known ?? null);
        if (known || !enabled) return;
        let alive = true;
        let timer = 0;
        let tries = 0;
        const tick = async () => {
            const found = await readTaskUrl(tabId, taskId);
            if (!alive) return;
            if (found) setUrl(found);
            else if (++tries < URL_POLL_MAX) timer = window.setTimeout(tick, URL_POLL_MS);
        };
        void tick();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [tabId, taskId, enabled]);
    return url;
}

// 실행 중인 셸 작업들 가운데 주소가 나온 첫 작업 (화면 대조의 기본 주소)
export async function findRunningUrl(tabId: string, state: BackgroundState): Promise<string | null> {
    const done = new Set(state.finished.map((f) => f.id));
    for (const t of state.running) {
        if (done.has(t.id) || t.type !== "local_bash" || !t.hasOutput) continue;
        const url = await readTaskUrl(tabId, t.id);
        if (url) return url;
    }
    return null;
}

// ── 그림 ──
export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("그림을 읽지 못했습니다"));
        img.src = src;
    });
}

// 그림이 대체로 어두운가 — 디자인이 어두운 화면이면 페이지도 어두운 화면 모드로 찍는다
export async function isDarkImage(src: string): Promise<boolean> {
    try {
        const img = await loadImage(src);
        const c = document.createElement("canvas");
        c.width = 24;
        c.height = 24;
        const ctx = c.getContext("2d");
        if (!ctx) return false;
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (d.length / 4) < 100;
    } catch {
        return false;
    }
}

// Claude에게 붙일 그림 — 긴 변 1568px까지 줄인다(API가 어차피 그 크기로 줄이고, 큰 PNG는 한 장 5MB 한도에 걸린다).
// 줄여도 크면 JPEG로.
const CLAUDE_MAX_SIDE = 1568;
const MAX_PNG_CHARS = 4_500_000;

export async function imagePayload(src: string, name: string, caption: string): Promise<ImagePayload> {
    const img = await loadImage(src);
    const k = Math.min(1, CLAUDE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("그림을 만들지 못했습니다");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let url = c.toDataURL("image/png");
    if (url.length > MAX_PNG_CHARS) url = c.toDataURL("image/jpeg", 0.9);
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (!m) throw new Error("그림을 만들지 못했습니다");
    return {previewUrl: url, data: m[2], mediaType: m[1], name, caption};
}

// "방금" · "3분 전" · "2시간 전" · "11월 18일"
export function timeAgo(at: number | undefined, now = Date.now()): string {
    if (!at) return "";
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return "방금";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}분 전`;
    if (s < 86_400) return `${Math.round(s / 3600)}시간 전`;
    return new Date(at).toLocaleDateString("ko-KR", {month: "long", day: "numeric"});
}

// ── 탭마다 패널 상태 — 다른 패널을 열었다 돌아와도, 다른 탭을 보고 와도 그대로 ──
export type CompareMode = "side" | "overlay" | "diff";

export interface CompareShot {
    dataUrl: string;
    url: string;
    width: number;
    height: number;
    at: number;
}

export interface CompareState {
    design: DesignImage | null;
    url: string;
    width: number;
    height: number;
    fullPage: boolean;
    scheme: "light" | "dark";
    sizeEdited: boolean; // 크기를 직접 고쳤다 — 디자인을 바꿔도 덮어쓰지 않는다
    shot: CompareShot | null;
    mode: CompareMode;
    opacity: number; // 겹쳐 보기에서 구현 쪽 불투명도 0~1
    appliedSeq?: number; // 마지막으로 적용한 여는 요청 — 패널이 다시 그려질 때 같은 요청을 또 적용하지 않게
}

const states = new Map<string, CompareState>();

export function compareStateOf(tabId: string): CompareState {
    return (
        states.get(tabId) ?? {
            design: null,
            url: "",
            width: 1440,
            height: 900,
            fullPage: false,
            scheme: "light",
            sizeEdited: false,
            shot: null,
            mode: "side",
            opacity: 0.5,
        }
    );
}

export function saveCompareState(tabId: string, s: CompareState) {
    states.set(tabId, s);
}

export function forgetCompareState(tabId: string) {
    states.delete(tabId);
}
