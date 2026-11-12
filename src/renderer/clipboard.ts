// 클립보드에 글자를 복사한다. 성공하면 true.
// 렌더러의 navigator.clipboard는 문서에 포커스가 없으면 실패한다(개발자 도구에 포커스가 있을 때 등 — 확인함).
// main의 Electron clipboard는 포커스와 상관없이 동작해서 그쪽으로 보낸다.
export async function copyText(text: string): Promise<boolean> {
    try {
        return await window.electronAPI.copyText(text);
    } catch {
        return false;
    }
}
