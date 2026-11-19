import {app} from "electron";
import path from "path";
import {readJsonFile, writeJsonFile} from "./json-store";
import {figmaDayKey, figmaToolInfo, isFigmaServer, looksLikeFigmaRateLimit} from "../../shared/figma";
import {parseMcpToolName} from "../../shared/mcp-tools";

// Figma 읽기 호출 세기 — Figma MCP 서버는 요금제·좌석마다 하루·분당(좌석이 없으면 한 달) 읽기 횟수가 정해져 있다
// (숫자는 src/shared/figma.ts의 FIGMA_PLANS). 이 앱으로 돈 대화(모든 탭, 에이전트 포함)의 메시지 흐름에서
// Figma 읽기 도구 호출(tool_use)을 센다 — 터미널·다른 앱에서 부른 것은 모른다. 쓰기 도구는 한도에서 빠져 세지 않는다.
// userData/figma-usage.json = 날짜별 횟수(최근 62일 — 한 달 한도용) + 최근 1분 안의 호출 시각.

interface UsageFile {
    days: Record<string, number>;
    recent: number[];
}

export interface FigmaUsage {
    days: Record<string, number>; // "2026-11-19" → 그날 읽기 호출 수 (이 컴퓨터 날짜)
    recent: number[]; // 최근 1분 안의 호출 시각 (ms) — 화면이 지금 시각으로 다시 센다
}

const KEEP_DAYS = 62;
const RECENT_MS = 60_000;
// 같은 호출을 두 번 세지 않게 — 도구 호출 id (메시지가 다시 오는 일은 드물지만 이어 쓰기·재개 때 대비)
const SEEN_MAX = 2000;

let cache: UsageFile | null = null;
const seen = new Set<string>();
// 결과가 오기 전의 Figma 도구 호출 (id → 도구 이름) — 결과가 한도 오류인지 볼 때
const pending = new Map<string, string>();

function file(): string {
    return path.join(app.getPath("userData"), "figma-usage.json");
}

function load(): UsageFile {
    if (cache) return cache;
    const raw = readJsonFile<Partial<UsageFile>>(file(), {});
    const days: Record<string, number> = {};
    if (raw.days && typeof raw.days === "object") {
        for (const [k, v] of Object.entries(raw.days)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === "number" && v > 0) days[k] = Math.floor(v);
        }
    }
    const recent = Array.isArray(raw.recent) ? raw.recent.filter((t): t is number => typeof t === "number") : [];
    cache = {days, recent};
    return cache;
}

function prune(u: UsageFile, now: number) {
    u.recent = u.recent.filter((t) => now - t < RECENT_MS && t <= now + 1000);
    const oldest = figmaDayKey(now - KEEP_DAYS * 86_400_000);
    for (const k of Object.keys(u.days)) if (k < oldest) delete u.days[k];
}

function save(u: UsageFile) {
    try {
        writeJsonFile(file(), u);
    } catch (e) {
        console.error("[figma] 호출 수 저장 실패", e);
    }
}

export function figmaUsage(): FigmaUsage {
    const u = load();
    prune(u, Date.now());
    return {days: {...u.days}, recent: [...u.recent]};
}

function count(id: string, now: number) {
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
    const u = load();
    const key = figmaDayKey(now);
    u.days[key] = (u.days[key] ?? 0) + 1;
    u.recent.push(now);
    prune(u, now);
    save(u);
}

interface Block {
    type?: string;
    id?: string;
    name?: string;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
}

function resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((c) => (c && typeof c === "object" && typeof (c as {text?: unknown}).text === "string" ? (c as {text: string}).text : "")).join("\n");
}

// SDK 메시지 하나를 본다 (pump가 모든 메시지 — 서브에이전트 것까지 — 넘긴다).
// counted: 읽기 호출을 센 수 / limited: 한도에 걸린 것으로 보이는 Figma 결과 (도구 이름, 결과 글)
export function observeFigmaMessage(msg: {type?: string; message?: {content?: unknown}}): {counted: number; limited: {tool: string; text: string}[]} {
    const out = {counted: 0, limited: [] as {tool: string; text: string}[]};
    const content = msg.message?.content;
    if (!Array.isArray(content)) return out;
    const now = Date.now();
    for (const b of content as Block[]) {
        if (msg.type === "assistant" && b?.type === "tool_use" && b.id && b.name) {
            const m = parseMcpToolName(b.name);
            if (!m || !isFigmaServer(m.server)) continue;
            if (pending.size > 500) pending.clear();
            pending.set(b.id, m.tool);
            if (figmaToolInfo(m.tool).kind === "read" && !seen.has(b.id)) {
                count(b.id, now);
                out.counted += 1;
            }
        } else if (msg.type === "user" && b?.type === "tool_result" && b.tool_use_id) {
            const tool = pending.get(b.tool_use_id);
            if (!tool) continue;
            pending.delete(b.tool_use_id);
            const text = resultText(b.content);
            if (looksLikeFigmaRateLimit(text, !!b.is_error)) out.limited.push({tool, text: text.slice(0, 2000)});
        }
    }
    return out;
}
