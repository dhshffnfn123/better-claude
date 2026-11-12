import {BrowserWindow, shell} from "electron";

// 앱 창 안에서 링크를 누르면 창 자체가 그 주소로 넘어가 버린다(Electron 기본 동작).
// 그러면 채팅 화면으로 돌아올 방법이 없다(재현됨). 웹 링크는 기본 브라우저로 열고,
// 그 밖의 이동(파일 링크 등)은 막는다 — 파일을 외부 프로그램으로 열면 실행 파일이 실행될 수 있다.

function parse(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

function openIfWebLink(win: BrowserWindow, url: string) {
    const target = parse(url);
    if (!target) return;
    if (target.protocol === "mailto:") {
        void shell.openExternal(target.toString());
        return;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") return;
    // 개발 모드에서는 `[main.ts](src/main.ts)` 같은 상대 링크가 개발 서버 주소가 된다 — 열지 않는다
    const current = parse(win.webContents.getURL());
    if (current && current.origin === target.origin) return;
    void shell.openExternal(target.toString());
}

// 같은 문서 안의 이동(새로고침 등)은 허용한다. 해시 라우팅은 애초에 이동 이벤트가 나지 않는다.
function isSameDocument(win: BrowserWindow, url: string): boolean {
    const current = parse(win.webContents.getURL());
    const next = parse(url);
    if (!current || !next) return false;
    return current.protocol === next.protocol && current.host === next.host && current.pathname === next.pathname;
}

export function guardNavigation(win: BrowserWindow) {
    // target="_blank" 링크·window.open — 새 창은 만들지 않는다
    win.webContents.setWindowOpenHandler(({url}) => {
        openIfWebLink(win, url);
        return {action: "deny"};
    });
    // 일반 링크 클릭 — 앱 창이 다른 곳으로 넘어가지 않게 막는다
    win.webContents.on("will-navigate", (event, url) => {
        if (isSameDocument(win, url)) return;
        event.preventDefault();
        openIfWebLink(win, url);
    });
}
