import {app, BrowserWindow} from "electron";
import path from "path";
import fs from "fs";

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

export const createMainWindow = () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 480,
        minHeight: 600,
        icon: resolveWindowIcon(),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        win.webContents.openDevTools();
    } else {
        win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    return win;
};
