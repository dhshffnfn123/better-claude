import {execFile} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// JetBrains IDE로 파일 열기 — 답변 속 파일 경로(⌘+클릭)·파일 링크, 작업 파일 패널의 "IDE에서 열기".
//
// 어느 IDE로 열지 따로 정하지 않는다: IDE마다 최근에 연 프로젝트 목록(options/recentProjects.xml)을 남기므로,
// 그 파일이 든 프로젝트를 마지막으로 연 IDE를 고른다. 어느 IDE도 그 프로젝트를 모르면 가장 최근에 쓴 IDE.
// 여는 방법은 JetBrains Toolbox가 만드는 실행 스크립트(webstorm, idea …)와 같다:
//   open -na <앱>/Contents/MacOS/<실행 파일> --args --line N <파일>
// 이미 떠 있는 IDE가 받아서 그 프로젝트 창에 연다.

interface Product {
    name: string; // 화면에 보이는 이름
    apps: string[]; // 앱 묶음 이름 (/Applications, ~/Applications — Toolbox는 ~/Applications에 둔다)
    config: string; // ~/Library/Application Support/JetBrains/<config><버전>
}

const PRODUCTS: Product[] = [
    {name: "WebStorm", apps: ["WebStorm.app"], config: "WebStorm"},
    {name: "IntelliJ IDEA", apps: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app"], config: "IntelliJIdea"},
    {name: "IntelliJ IDEA CE", apps: ["IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"], config: "IdeaIC"},
    {name: "PyCharm", apps: ["PyCharm.app", "PyCharm Professional Edition.app"], config: "PyCharm"},
    {name: "PyCharm CE", apps: ["PyCharm CE.app", "PyCharm Community Edition.app"], config: "PyCharmCE"},
    {name: "GoLand", apps: ["GoLand.app"], config: "GoLand"},
    {name: "PhpStorm", apps: ["PhpStorm.app"], config: "PhpStorm"},
    {name: "RubyMine", apps: ["RubyMine.app"], config: "RubyMine"},
    {name: "CLion", apps: ["CLion.app"], config: "CLion"},
    {name: "Rider", apps: ["Rider.app"], config: "Rider"},
    {name: "RustRover", apps: ["RustRover.app"], config: "RustRover"},
    {name: "DataGrip", apps: ["DataGrip.app"], config: "DataGrip"},
];

interface InstalledIde {
    name: string;
    exe: string; // <앱>/Contents/MacOS/<실행 파일>
    projects: {path: string; at: number}[]; // 최근 연 프로젝트와 마지막으로 연 시각(epoch ms)
}

const CACHE_MS = 60_000;
let cache: {at: number; ides: InstalledIde[]} | null = null;

function plistExecutable(appPath: string): string | null {
    try {
        const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
        return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
    } catch {
        return null;
    }
}

// <entry key="$USER_HOME$/WebstormProjects/foo"> … <option name="activationTimestamp" value="1762912345678" />
function recentProjects(configPrefix: string): {path: string; at: number}[] {
    const base = path.join(os.homedir(), "Library", "Application Support", "JetBrains");
    let dirs: string[] = [];
    try {
        // 이름 뒤에 바로 버전이 와야 한다 — PyCharm이 PyCharmCE까지 잡지 않게
        const re = new RegExp(`^${configPrefix}\\d{4}\\.\\d+$`);
        dirs = fs.readdirSync(base).filter((d) => re.test(d));
    } catch {
        return [];
    }
    const out: {path: string; at: number}[] = [];
    for (const d of dirs) {
        let xml = "";
        try {
            xml = fs.readFileSync(path.join(base, d, "options", "recentProjects.xml"), "utf8");
        } catch {
            continue;
        }
        for (const m of xml.matchAll(/<entry key="([^"]+)">([\s\S]*?)<\/entry>/g)) {
            const p = m[1].replace("$USER_HOME$", os.homedir());
            const at = Number(/name="(?:activationTimestamp|projectOpenTimestamp)" value="(\d+)"/.exec(m[2])?.[1] ?? 0);
            out.push({path: p, at});
        }
    }
    return out;
}

function installedIdes(): InstalledIde[] {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.ides;
    const roots = ["/Applications", path.join(os.homedir(), "Applications")];
    const ides: InstalledIde[] = [];
    for (const p of PRODUCTS) {
        const appPath = roots.flatMap((r) => p.apps.map((a) => path.join(r, a))).find((a) => fs.existsSync(a));
        if (!appPath) continue;
        const exe = plistExecutable(appPath);
        if (!exe) continue;
        ides.push({name: p.name, exe: path.join(appPath, "Contents", "MacOS", exe), projects: recentProjects(p.config)});
    }
    cache = {at: Date.now(), ides};
    return ides;
}

// 그 파일이 든 프로젝트(가장 안쪽)를 마지막으로 연 IDE → 없으면 가장 최근에 쓴 IDE → 없으면 설치된 첫 IDE
export function pickIde(file: string): InstalledIde | null {
    const ides = installedIdes();
    if (ides.length === 0) return null;
    let best: {ide: InstalledIde; depth: number; at: number} | null = null;
    for (const ide of ides) {
        for (const pr of ide.projects) {
            if (file !== pr.path && !file.startsWith(pr.path.endsWith("/") ? pr.path : pr.path + "/")) continue;
            const depth = pr.path.length;
            if (!best || depth > best.depth || (depth === best.depth && pr.at > best.at)) best = {ide, depth, at: pr.at};
        }
    }
    if (best) return best.ide;
    const lastUsed = (ide: InstalledIde) => Math.max(0, ...ide.projects.map((p) => p.at));
    return [...ides].sort((a, b) => lastUsed(b) - lastUsed(a))[0];
}

export function openInIde(ide: InstalledIde, file: string, line?: number): Promise<void> {
    const args = ["-na", ide.exe, "--args", ...(line ? ["--line", String(line)] : []), file];
    return new Promise((resolve, reject) => {
        execFile("open", args, (err) => (err ? reject(err) : resolve()));
    });
}
