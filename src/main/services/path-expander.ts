import fs from "fs";
import os from "os";
import path from "path";

function findNvmNodeBins(home: string): string[] {
    const nvmDir = path.join(home, ".nvm", "versions", "node");
    try {
        if (!fs.statSync(nvmDir).isDirectory()) return [];
    } catch {
        return [];
    }
    try {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        return versions
            .map((v) => path.join(nvmDir, v, "bin"))
            .filter((p) => {
                try {
                    return fs.statSync(p).isDirectory();
                } catch {
                    return false;
                }
            });
    } catch {
        return [];
    }
}

// GUI로 실행된 Electron 앱은 PATH가 최소한으로만 설정되어 있다 (launchd 기본값).
// 터미널에서 실행할 때처럼 사용자 셸 설정이 반영되지 않아 node/claude/open 등의
// 서브 커맨드가 실패하는 일이 흔하다. 흔한 bin 디렉토리를 process.env.PATH에 병합.
export function expandPathForChildProcesses(): void {
    const home = os.homedir();
    const extras = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        path.join(home, ".local", "bin"),
        path.join(home, ".npm-global", "bin"),
        path.join(home, ".volta", "bin"),
        path.join(home, ".volta", "tools", "image", "node", "current", "bin"),
        path.join(home, ".bun", "bin"),
        path.join(home, ".cargo", "bin"),
        path.join(home, ".fnm", "current", "bin"),
        ...findNvmNodeBins(home),
    ];
    if (process.env.NVM_BIN) extras.push(process.env.NVM_BIN);

    const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const p of [...existing, ...extras]) {
        if (seen.has(p)) continue;
        seen.add(p);
        merged.push(p);
    }
    process.env.PATH = merged.join(path.delimiter);

    // node-pty 등 일부 라이브러리가 SHELL 기대하는 경우 대비
    if (!process.env.SHELL) process.env.SHELL = "/bin/zsh";
}
