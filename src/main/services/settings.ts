import {app} from "electron";
import path from "path";
import {readJsonFile, writeJsonFile} from "./json-store";

export interface AppSettings {
    claudePath?: string;
    // 채팅 설정 — 앱을 다시 켜도 유지된다
    model?: string;
    effort?: string;
    ultracode?: boolean;
    fastMode?: boolean;
    systemPrompts?: string[];
}

function settingsPath(): string {
    return path.join(app.getPath("userData"), "settings.json");
}

let cache: AppSettings | null = null;

export function load(): AppSettings {
    if (!cache) cache = readJsonFile<AppSettings>(settingsPath(), {});
    return cache;
}

export function save(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = {...load(), ...patch};
    try {
        writeJsonFile(settingsPath(), next);
    } catch (e) {
        // 저장에 실패해도 이번 실행 동안은 메모리 값으로 동작한다
        console.error("[settings] 저장 실패", e);
    }
    cache = next;
    return next;
}

export function getClaudePath(): string | undefined {
    return load().claudePath;
}

export function setClaudePath(p: string | null): void {
    if (p == null) {
        const next = {...load()};
        delete next.claudePath;
        writeJsonFile(settingsPath(), next);
        cache = next;
    } else {
        save({claudePath: p});
    }
}
