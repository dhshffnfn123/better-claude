import {useEffect, useState} from "react";

// 다음 요청 추천 켜기·끄기 — main의 settings.json에 저장한다(새로 띄우는 CLI부터 적용).
// 입력창(ChatInput)과 알림 설정 창이 같은 값을 보도록 여기서 한 번 읽어 나눠 준다.
let current = true;
const listeners = new Set<(on: boolean) => void>();

void window.electronAPI.getPromptSuggestions().then((on) => {
    current = on;
    listeners.forEach((l) => l(on));
});

export function useSuggestionsEnabled(): [boolean, (on: boolean) => void] {
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
        listeners.forEach((l) => l(next));
        void window.electronAPI.setPromptSuggestions(next);
    };
    return [on, set];
}
