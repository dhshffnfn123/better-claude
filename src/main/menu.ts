import {app, BrowserWindow, Menu, type MenuItemConstructorOptions} from "electron";

// 앱 메뉴. 기본 메뉴는 ⌘W가 "창 닫기"라서, 탭을 닫으려다 창이 닫힌다 — 탭 단축키를 메뉴에 둔다.
// 메뉴 단축키는 입력칸에 커서가 있어도 동작한다. 실제 동작은 렌더러가 한다(menu:tab 이벤트).
// 편집 메뉴(복사·붙여넣기·실행 취소)는 role로 그대로 둔다 — 빼면 입력칸에서 ⌘C/⌘V가 안 먹는다.
// 보기 메뉴는 새로고침에 확인을 걸려고 직접 만든다(나머지 항목은 role 그대로).

export type TabMenuAction = "new" | "close" | "next" | "prev" | `select:${number}`;

function sendTab(action: TabMenuAction) {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) win.webContents.send("menu:tab", action);
}

export interface AppMenuHooks {
    // 새로고침 전에 묻는다 — 화면을 새로 고치면 그 창의 탭이 모두 멈춘다. 계속하면 true.
    confirmReload: (win: BrowserWindow) => boolean;
}

// 보기 메뉴의 새로고침 — 기본 role("reload")은 묻지 않고 바로 새로 고친다
function reloadItem(hooks: AppMenuHooks, label: string, accelerator: string, ignoreCache: boolean): MenuItemConstructorOptions {
    return {
        label,
        accelerator,
        // 메뉴가 넘겨 주는 창(포커스된 창)을 쓴다
        click: (_item, target) => {
            const win = target instanceof BrowserWindow ? target : BrowserWindow.getFocusedWindow();
            if (!win || win.isDestroyed() || !hooks.confirmReload(win)) return;
            if (ignoreCache) win.webContents.reloadIgnoringCache();
            else win.webContents.reload();
        },
    };
}

export function installAppMenu(hooks: AppMenuHooks) {
    const isMac = process.platform === "darwin";
    const selectItems: MenuItemConstructorOptions[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
        label: n === 9 ? "마지막 탭" : `탭 ${n}`,
        accelerator: `CmdOrCtrl+${n}`,
        click: () => sendTab(`select:${n}`),
    }));
    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{label: app.name, role: "appMenu" as const}] : []),
        {
            label: "파일",
            submenu: [
                {label: "새 탭", accelerator: "CmdOrCtrl+T", click: () => sendTab("new")},
                {label: "탭 닫기", accelerator: "CmdOrCtrl+W", click: () => sendTab("close")},
                {type: "separator"},
                {label: "창 닫기", accelerator: "CmdOrCtrl+Shift+W", role: "close"},
            ],
        },
        {role: "editMenu"},
        {
            label: "보기",
            submenu: [
                reloadItem(hooks, "새로고침", "CmdOrCtrl+R", false),
                reloadItem(hooks, "강제 새로고침", "Shift+CmdOrCtrl+R", true),
                {label: "개발자 도구", role: "toggleDevTools"},
                {type: "separator"},
                {label: "실제 크기", role: "resetZoom"},
                {label: "확대", role: "zoomIn"},
                {label: "축소", role: "zoomOut"},
                {type: "separator"},
                {label: "전체 화면", role: "togglefullscreen"},
            ],
        },
        {
            label: "탭",
            submenu: [
                {label: "다음 탭", accelerator: "Ctrl+Tab", click: () => sendTab("next")},
                {label: "이전 탭", accelerator: "Ctrl+Shift+Tab", click: () => sendTab("prev")},
                {type: "separator"},
                ...selectItems,
            ],
        },
        {role: "windowMenu"},
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
