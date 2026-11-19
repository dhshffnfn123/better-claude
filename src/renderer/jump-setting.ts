import {useEffect, useState} from "react";

// "답변 처음으로" 버튼의 기준 — 사이드바 "설정"에서 고른다. 모든 탭에 같이 쓰고 localStorage에 남긴다.
// reading = 화면 맨 위에 걸친(지금 읽고 있는) 답변의 처음으로 (기본)
// last = 어디를 보고 있든 가장 최근 답변의 처음으로 ("마지막 답변 기준으로 올리고 싶다"는 의견)
// 설정 창과 열려 있는 모든 탭 화면이 같은 값을 보도록 여기서 한 번 읽어 나눠 준다 (suggestion-setting.ts와 같은 방식).
export type JumpMode = "reading" | "last";

const KEY = "better-claude:jump-reply";
let current: JumpMode = localStorage.getItem(KEY) === "last" ? "last" : "reading";
const listeners = new Set<(mode: JumpMode) => void>();

export function useJumpMode(): [JumpMode, (mode: JumpMode) => void] {
    const [mode, setMode] = useState(current);
    useEffect(() => {
        listeners.add(setMode);
        setMode(current);
        return () => {
            listeners.delete(setMode);
        };
    }, []);
    const set = (next: JumpMode) => {
        current = next;
        localStorage.setItem(KEY, next);
        listeners.forEach((l) => l(next));
    };
    return [mode, set];
}
