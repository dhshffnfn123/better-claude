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
