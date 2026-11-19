import {useEffect, useState} from "react";

// Figma 기능 켜기·끄기 — 사이드바 "설정"의 Figma 묶음. 끄면 앱이 그리는 Figma 화면만 숨긴다: 도구 줄의 Figma 이름·로고·
// 열기 링크(기본 "서버 · 도구" 모양으로), 입력창·보낸 메시지의 Figma 링크 카드와 빠른 작업, MCP 창의 호출 수, 화면 대조
// (들어가는 버튼들, 열려 있던 패널도 닫힌다). Figma 플러그인·MCP 서버 자체는 그대로다 — Claude는 계속 Figma 도구를 쓴다.
// 모든 탭에 바로 적용되고 localStorage에 남는다(기본 켬). 설정 창과 모든 화면이 같은 값을 보도록 여기서 한 번 읽어
// 나눠 준다 (jump-setting.ts·suggestion-setting.ts와 같은 방식).

const KEY = "better-claude:figma-features";

function read(): boolean {
    try {
        return localStorage.getItem(KEY) !== "off";
    } catch {
        return true;
    }
}

let current = read();
const listeners = new Set<(on: boolean) => void>();

// 훅 밖(순수 함수 — 도구 줄 꾸미기 등)에서 지금 값
export function figmaFeaturesOn(): boolean {
    return current;
}

// 값이 바뀔 때 부른다 (훅을 쓰지 않는 곳 — 도구 줄 꾸미기 층). 끊는 함수를 돌려준다.
export function onFigmaFeaturesChange(cb: (on: boolean) => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function useFigmaFeatures(): [boolean, (on: boolean) => void] {
    const [on, setOn] = useState(current);
    useEffect(() => {
        listeners.add(setOn);
        setOn(current);
        return () => {
            listeners.delete(setOn);
        };
    }, []);
    const set = (next: boolean) => {
        current = next;
        try {
            localStorage.setItem(KEY, next ? "on" : "off");
        } catch {
            // 저장이 막힌 환경 — 이번 실행 동안만
        }
        listeners.forEach((l) => l(next));
    };
    return [on, set];
}
