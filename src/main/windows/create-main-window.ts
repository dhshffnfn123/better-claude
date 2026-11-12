import {app, BrowserWindow, nativeTheme} from "electron";
import path from "path";
import fs from "fs";
import {guardNavigation} from "./link-guard";

function resolveWindowIcon(): string | undefined {
    const candidates = [
        path.join(app.getAppPath(), "assets", "icon.png"),
        path.join(process.cwd(), "assets", "icon.png"),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return undefined;
}

// 화면이 그려지기 전 창 바탕 — 처음 보이는 시작 화면(SplashScreen)과 같은 색이라 번쩍이지 않는다.
// styles/theme.css의 --c-header-bg 라이트·다크 값과 맞춘다. (기본값 흰색이면 다크 모드에서 흰 화면이 번쩍였다)
const SPLASH_BG = {light: "#4a5245", dark: "#2b3027"};

export function windowBackground(): string {
    return nativeTheme.shouldUseDarkColors ? SPLASH_BG.dark : SPLASH_BG.light;
}

export const createMainWindow = () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 480,
        minHeight: 600,
        backgroundColor: windowBackground(),
        icon: resolveWindowIcon(),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    guardNavigation(win);

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        win.webContents.openDevTools();
    } else {
        win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    return win;
};
