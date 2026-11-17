// 작업 파일 패널 설정 — 열림·너비·"바뀐 파일만"은 이 기기에서만 기억한다(localStorage).
// 저장이 막힌 환경이면 이번 실행 동안만 유지된다.
// 컴포넌트 파일(FilesPanel.tsx)에서 컴포넌트가 아닌 것을 함께 내보내면 React Fast Refresh가 꺼져서 따로 둔다.

export const FILES_PANEL_MIN_WIDTH = 260;

export function readPref(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function writePref(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 무시
    }
}

// 오른쪽 패널의 왼쪽 가장자리를 끌어 너비 조절 — 작업 파일 패널과 같은 너비를 쓴다(창 너비의 70%까지)
export function startPanelResize(e: {preventDefault: () => void}, onResize: (width: number) => void) {
    e.preventDefault();
    const move = (ev: PointerEvent) =>
        onResize(Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, FILES_PANEL_MIN_WIDTH), window.innerWidth * 0.7)));
    const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
}
