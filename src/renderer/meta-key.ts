// ⌘를 누르고 있는 동안 <html>에 meta-down 클래스를 단다 — 답변 속 파일 경로가 ⌘+클릭으로 열린다는 걸
// 누르고 있을 때만 링크처럼(밑줄·손가락 커서) 보이게 하려고. 창을 떠나면(⌘+Tab 등) 뗀 것으로 친다.
export function installMetaKeyClass(): void {
    const root = document.documentElement;
    const set = (on: boolean) => root.classList.toggle("meta-down", on);
    window.addEventListener("keydown", (e) => set(e.metaKey));
    window.addEventListener("keyup", (e) => set(e.metaKey));
    window.addEventListener("blur", () => set(false));
}
