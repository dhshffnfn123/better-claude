import {useEffect, useState} from "react";

// 기억 알림 켜기·끄기 — Claude가 기억(자동 메모리)에 무언가를 적으면 창 가운데에 "클로드는 이것을 기억할 것입니다"를
// 잠깐 띄운다(MemoryToast.tsx). 사이드바 "설정"에서 끈다. 기본은 켜짐, 모든 탭에 같이 쓰고 localStorage에 남긴다.
// 설정 창과 알림을 띄우는 쪽이 같은 값을 보도록 여기서 한 번 읽어 나눠 준다 (jump-setting.ts와 같은 방식).
const KEY = "better-claude:memory-toast";
let current = localStorage.getItem(KEY) !== "off";
const listeners = new Set<(on: boolean) => void>();

// 훅 밖(이벤트 받는 곳)에서 지금 값
export function memoryToastEnabled(): boolean {
    return current;
}

export function useMemoryToastEnabled(): [boolean, (on: boolean) => void] {
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
        localStorage.setItem(KEY, next ? "on" : "off");
        listeners.forEach((l) => l(next));
    };
    return [on, set];
}
