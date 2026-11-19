import {useCallback, useSyncExternalStore} from "react";
import {onTab} from "./tab-events";

// 탭마다 이 폴더의 스킬·사용자 명령 이름 (CLI 명령 목록 중 내장이 아닌 것, MCP 프롬프트 빼고) — 내 메시지가 /이름으로
// 시작하면 "스킬 · 이름" 표시를 붙이려고. 입력창("/" 메뉴)과 같은 목록(commands:list, chat:commands)을 탭마다 한 번만 받는다.
// 보는 메시지가 하나도 없으면 구독을 끊는다.

interface Entry {
    names: Set<string> | null; // 아직 모르면 null
    listeners: Set<() => void>;
    off: (() => void) | null;
    drop: ReturnType<typeof setTimeout> | null; // 보는 메시지가 없어진 뒤 조금 있다가 구독을 끊는다
}

// 메시지가 다시 그려지며 잠깐 0이 되는 것까지 매번 끊었다 다시 묻지 않게 — 이만큼 지나도 없으면 끊는다
const DROP_AFTER_MS = 30_000;

const entries = new Map<string, Entry>();
const EMPTY: Set<string> | null = null;

function apply(tabId: string, list: SlashCommand[]) {
    const e = entries.get(tabId);
    if (!e) return;
    e.names = new Set(
        list.filter((c) => c.source === "custom" && !c.name.startsWith("/mcp__")).map((c) => c.name.replace(/^\//, ""))
    );
    e.listeners.forEach((l) => l());
}

function subscribe(tabId: string, listener: () => void): () => void {
    let e = entries.get(tabId);
    if (!e) {
        e = {names: null, listeners: new Set(), off: null, drop: null};
        entries.set(tabId, e);
    }
    if (e.drop) clearTimeout(e.drop);
    e.drop = null;
    e.listeners.add(listener);
    if (!e.off) {
        e.off = onTab("commands", tabId, (list) => apply(tabId, list));
        void window.electronAPI
            .listCommands(tabId)
            .then((list) => apply(tabId, list))
            .catch(() => undefined);
    }
    return () => {
        const cur = entries.get(tabId);
        if (!cur) return;
        cur.listeners.delete(listener);
        if (cur.listeners.size > 0 || cur.drop) return;
        cur.drop = setTimeout(() => {
            if (entries.get(tabId) !== cur || cur.listeners.size > 0) return;
            cur.off?.();
            entries.delete(tabId);
        }, DROP_AFTER_MS);
    };
}

// subscribe는 같은 함수여야 한다 — 그리면서 새 함수를 넘기면 React가 매번 다시 구독하고, 그때 구독이 0이 되어 목록을 버렸다가
// 다시 묻고(→ 다시 그림 → 다시 구독…) 화면이 멈췄다 (실제로 겪음)
export function useSkillNames(tabId: string): Set<string> | null {
    const sub = useCallback((l: () => void) => (tabId ? subscribe(tabId, l) : () => undefined), [tabId]);
    const snap = useCallback(() => (tabId ? entries.get(tabId)?.names ?? EMPTY : EMPTY), [tabId]);
    return useSyncExternalStore(sub, snap);
}

// 메시지 맨 앞의 /이름 — 스킬 이름 모양(글자·숫자·-·_·:·.)만. 경로(/Users/…)는 "/" 뒤에 또 "/"가 와서 걸리지 않는다.
export function leadingSlashName(text: string): string | null {
    const m = /^\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/.exec(text);
    return m ? m[1] : null;
}
