import {execFile, execFileSync} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import * as settings from "./settings";

function isExecutable(p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        const stat = fs.statSync(p);
        return stat.isFile();
    } catch {
        return false;
    }
}

function fromEnv(): string | null {
    const p = process.env.CLAUDE_PATH;
    return p && isExecutable(p) ? p : null;
}

function fromUserSettings(): string | null {
    const p = settings.getClaudePath();
    return p && isExecutable(p) ? p : null;
}

function fromKnownPaths(): string | null {
    const home = os.homedir();
    const candidates = [
        path.join(home, ".local", "bin", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        path.join(home, ".npm-global", "bin", "claude"),
        path.join(home, ".volta", "bin", "claude"),
        path.join(home, ".bun", "bin", "claude"),
    ];
    for (const c of candidates) {
        if (isExecutable(c)) return c;
    }
    return null;
}

function fromWhich(): string | null {
    try {
        const out = execFileSync("/usr/bin/which", ["claude"], {
            encoding: "utf-8",
            timeout: 2000,
        }).trim();
        return out && isExecutable(out) ? out : null;
    } catch {
        return null;
    }
}

let cached: string | null | undefined;

export function resolveClaudePath(): string | null {
    if (cached !== undefined) return cached;
    cached = fromEnv() ?? fromUserSettings() ?? fromKnownPaths() ?? fromWhich();
    return cached;
}

export function resetCache(): void {
    cached = undefined;
}

export function validateClaudeBinary(candidate: string): Promise<{ok: boolean; error?: string}> {
    return new Promise((resolve) => {
        if (!isExecutable(candidate)) {
            resolve({ok: false, error: "실행 가능한 파일이 아닙니다"});
            return;
        }
        execFile(candidate, ["--version"], {timeout: 5000}, (err, stdout, stderr) => {
            if (err) {
                resolve({ok: false, error: `실행 실패: ${err.message}`});
                return;
            }
            const out = (stdout || stderr || "").toString().toLowerCase();
            if (!out.includes("claude")) {
                resolve({ok: false, error: "Claude CLI가 아닌 것 같습니다 (--version 출력 확인 실패)"});
                return;
            }
            resolve({ok: true});
        });
    });
}
