import {execFile, spawnSync} from "child_process";
import fs from "fs";
import path from "path";

// 작업 파일 패널의 "Git 변경" 보기: 마지막 커밋 이후 바뀐 파일과 그 차이.
// Claude가 수정·쓰기 도구로 고친 것만 아는 "Claude 수정" 보기와 달리, Bash·에디터·다른 대화가 바꾼 것까지 모두 보인다.
// 읽기만 한다 — 스테이징·커밋·되돌리기는 하지 않는다.

export type GitChangeKind =
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "copied"
    | "typechange"
    | "untracked"
    | "conflict";

export interface GitChange {
    path: string; // 절대 경로 (앱이 쓰는 작업 폴더 표기)
    rel: string; // 저장소 루트 기준 경로 — git 명령에 넘긴다
    origRel?: string; // 이름 변경 전 경로 (저장소 루트 기준)
    origPath?: string; // 이름 변경 전 절대 경로 (표시용)
    kind: GitChangeKind;
    staged: boolean; // 스테이징된 변경이 있다
    unstaged: boolean; // 스테이징 안 된 변경이 있다
    added?: number; // 바뀐 줄 수 (추적 중인 텍스트 파일만)
    deleted?: number;
    binary?: boolean;
}

export interface GitBranch {
    head: string | null; // 브랜치 이름 (detached면 null)
    detached: boolean;
    initial: boolean; // 아직 커밋이 하나도 없다
    upstream?: string;
    ahead?: number;
    behind?: number;
}

export type GitStatusResult =
    | {ok: true; root: string; branch: GitBranch; files: GitChange[]; truncated: boolean}
    | {ok: false; reason: "no-git" | "not-repo" | "error"; message?: string};

export interface GitDiffResult {
    text?: string; // unified diff
    truncated?: boolean;
    binary?: boolean;
    untracked?: boolean; // 새 파일 — 내용 전체를 추가로 보여 준다
    error?: string;
}

// 추적하지 않는 폴더(빌드 결과 등)에 파일이 아주 많으면 목록이 끝없이 길어진다
const MAX_FILES = 2000;
const MAX_DIFF_CHARS = 1_000_000;
const MAX_UNTRACKED_BYTES = 512 * 1024;

let gitBin: string | undefined;

// macOS의 /usr/bin/git은 개발자 도구(Command Line Tools)가 없으면 설치 안내 창을 띄우는 껍데기다.
// 패널을 여는 것만으로 그 창이 뜨면 안 되니, 그때는 git이 없는 것으로 본다.
// 못 찾은 결과는 기억하지 않는다 — 앱을 켠 채로 git을 설치할 수 있다.
function findGit(): string | null {
    if (gitBin) return gitBin;
    let found: string | null = null;
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, "git");
        try {
            fs.accessSync(p, fs.constants.X_OK);
            if (fs.statSync(p).isFile()) {
                found = p;
                break;
            }
        } catch {
            // 다음 폴더
        }
    }
    if (found === "/usr/bin/git" && process.platform === "darwin") {
        const r = spawnSync("/usr/bin/xcode-select", ["-p"], {stdio: "ignore", timeout: 5000});
        if (r.status !== 0) found = null;
    }
    if (found) gitBin = found;
    return found;
}

interface GitRun {
    code: number;
    out: string;
    err: string;
    tooBig: boolean; // 출력이 maxBuffer를 넘어 잘렸다
}

function runGit(git: string, cwd: string, args: string[], maxBuffer: number): Promise<GitRun> {
    return new Promise((resolve) => {
        execFile(
            git,
            ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args],
            {
                cwd,
                encoding: "utf8",
                maxBuffer,
                timeout: 15_000,
                // status가 index.lock을 잡지 않게 — 사용자가 터미널에서 커밋하는 중에 부딪히지 않도록 (VS Code와 같은 설정)
                env: {...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0"},
            },
            (error, stdout, stderr) => {
                const code = (error as {code?: unknown} | null)?.code;
                resolve({
                    code: error ? (typeof code === "number" ? code : -1) : 0,
                    out: String(stdout ?? ""),
                    err: String(stderr ?? ""),
                    tooBig: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                });
            }
        );
    });
}

function firstLine(s: string): string {
    return s.trim().split("\n")[0]?.replace(/^(fatal|error):\s*/, "") ?? "";
}

// 위로 올라가며 .git(폴더 또는 파일 — worktree·submodule은 파일)을 찾는다. git 메시지 문구에 기대지 않으려고 직접 본다.
function insideRepo(dir: string): boolean {
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, ".git"))) return true;
        if (path.dirname(d) === d) return false;
    }
}

// "1 XY sub mH mI mW hH hI path"처럼 공백으로 나뉜 앞 n칸과 나머지(경로 — 공백이 들어 있을 수 있다)
function fields(rec: string, n: number): {head: string[]; rest: string} {
    const head: string[] = [];
    let pos = 0;
    for (let k = 0; k < n; k++) {
        const sp = rec.indexOf(" ", pos);
        if (sp < 0) return {head, rest: ""};
        head.push(rec.slice(pos, sp));
        pos = sp + 1;
    }
    return {head, rest: rec.slice(pos)};
}

function classify(type: string, xy: string): GitChangeKind {
    if (type === "u") return "conflict";
    if (type === "?") return "untracked";
    if (type === "2") return xy[0] === "C" ? "copied" : "renamed";
    if (xy[0] === "D" || xy[1] === "D") return "deleted";
    if (xy[0] === "A") return "added";
    if (xy[0] === "T" || xy[1] === "T") return "typechange";
    return "modified";
}

// git status --porcelain=v2 -z --branch
function parseStatus(out: string, root: string, mapPath: (abs: string) => string) {
    const branch: GitBranch = {head: null, detached: false, initial: false};
    const files: GitChange[] = [];
    let truncated = false;
    const recs = out.split("\0");
    for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        if (!rec) continue;
        if (rec.startsWith("# ")) {
            const sp = rec.indexOf(" ", 2);
            const key = sp < 0 ? rec.slice(2) : rec.slice(2, sp);
            const val = sp < 0 ? "" : rec.slice(sp + 1);
            if (key === "branch.oid") branch.initial = val === "(initial)";
            else if (key === "branch.head") {
                branch.detached = val === "(detached)";
                branch.head = branch.detached ? null : val;
            } else if (key === "branch.upstream") branch.upstream = val;
            else if (key === "branch.ab") {
                const m = /^\+(\d+) -(\d+)$/.exec(val);
                if (m) {
                    branch.ahead = Number(m[1]);
                    branch.behind = Number(m[2]);
                }
            }
            continue;
        }
        const type = rec[0];
        // 이름 변경 항목은 다음 칸에 원래 경로가 붙어 온다 — 건너뛸 때도 같이 넘긴다
        if (files.length >= MAX_FILES) {
            truncated = true;
            if (type === "2") i++;
            continue;
        }
        let xy = "..";
        let rel = "";
        let origRel: string | undefined;
        if (type === "1") {
            const f = fields(rec, 8);
            xy = f.head[1] ?? "..";
            rel = f.rest;
        } else if (type === "2") {
            const f = fields(rec, 9);
            xy = f.head[1] ?? "..";
            rel = f.rest;
            origRel = recs[++i];
        } else if (type === "u") {
            const f = fields(rec, 10);
            xy = f.head[1] ?? "..";
            rel = f.rest;
        } else if (type === "?") {
            rel = rec.slice(2);
        } else {
            continue; // "!" (무시된 파일) — 요청하지 않았다
        }
        if (!rel) continue;
        files.push({
            path: mapPath(path.join(root, rel)),
            rel,
            origRel,
            origPath: origRel ? mapPath(path.join(root, origRel)) : undefined,
            kind: classify(type, xy),
            staged: type !== "?" && xy[0] !== ".",
            unstaged: type === "?" || xy[1] !== ".",
        });
    }
    return {branch, files, truncated};
}

// git diff --numstat -z: "추가\t삭제\t경로" — 이름 변경은 "추가\t삭제\t" 다음 칸에 원래 경로, 그다음 칸에 새 경로
function parseNumstat(out: string): Map<string, {added?: number; deleted?: number; binary: boolean}> {
    const map = new Map<string, {added?: number; deleted?: number; binary: boolean}>();
    const recs = out.split("\0");
    for (let i = 0; i < recs.length; i++) {
        const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(recs[i]);
        if (!m) continue;
        let p = m[3];
        if (p === "") {
            i++; // 원래 경로
            p = recs[++i] ?? "";
        }
        const binary = m[1] === "-";
        map.set(p, {added: binary ? undefined : Number(m[1]), deleted: binary ? undefined : Number(m[2]), binary});
    }
    return map;
}

// cwd(작업 폴더) 아래의 변경만 본다 — 패널의 트리와 같은 범위이고, main이 열어 주는 파일 범위와도 같다.
// mapPath: git이 주는 실제 경로를 앱의 작업 폴더 표기로 바꾼다 (심볼릭 링크로 연 폴더).
export async function getGitStatus(cwd: string, mapPath: (abs: string) => string): Promise<GitStatusResult> {
    if (!fs.existsSync(cwd)) return {ok: false, reason: "error", message: "작업 폴더가 없습니다"};
    if (!insideRepo(cwd)) return {ok: false, reason: "not-repo"};
    const git = findGit();
    if (!git) return {ok: false, reason: "no-git"};

    const top = await runGit(git, cwd, ["rev-parse", "--show-toplevel"], 1 << 20);
    if (top.code !== 0) return {ok: false, reason: "error", message: firstLine(top.err)};
    const root = top.out.trim();

    const st = await runGit(git, cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."], 32 << 20);
    if (st.code !== 0 && !st.tooBig) return {ok: false, reason: "error", message: firstLine(st.err)};
    const {branch, files, truncated} = parseStatus(st.out, root, mapPath);

    // 바뀐 줄 수 — 스테이징 여부와 상관없이 마지막 커밋과 비교한다 (커밋이 아직 없으면 스테이징된 것만)
    if (files.some((f) => f.kind !== "untracked")) {
        const args = branch.initial
            ? ["diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--", "."]
            : ["diff", "HEAD", "--numstat", "-z", "-M", "--no-ext-diff", "--", "."];
        const ns = await runGit(git, cwd, args, 16 << 20);
        if (ns.code === 0) {
            const counts = parseNumstat(ns.out);
            for (const f of files) {
                const c = counts.get(f.rel);
                if (c) Object.assign(f, c);
            }
        }
    }
    return {ok: true, root, branch, files, truncated: truncated || st.tooBig};
}

// 새 파일은 git이 비교할 대상이 없다 — 내용 전체를 추가된 줄로 보여 준다 (같은 모양의 diff로 만들어 화면을 하나로)
function untrackedDiff(abs: string): GitDiffResult {
    try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return {error: "파일이 아닙니다"};
        const len = Math.min(st.size, MAX_UNTRACKED_BYTES);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(abs, "r");
        try {
            fs.readSync(fd, buf, 0, len, 0);
        } finally {
            fs.closeSync(fd);
        }
        if (buf.subarray(0, Math.min(len, 8000)).includes(0)) return {binary: true, untracked: true};
        const text = buf.toString("utf8");
        const endsWithNewline = text.endsWith("\n");
        const lines = text.split("\n");
        if (endsWithNewline) lines.pop();
        if (text === "") return {text: "", untracked: true};
        const body = lines.map((l) => "+" + l).join("\n");
        const tail = endsWithNewline ? "" : "\n\\ No newline at end of file";
        return {text: `@@ -0,0 +1,${lines.length} @@\n${body}${tail}`, untracked: true, truncated: st.size > MAX_UNTRACKED_BYTES};
    } catch {
        return {error: "파일을 읽을 수 없습니다"};
    }
}

export async function getGitDiff(root: string, change: GitChange, initial: boolean): Promise<GitDiffResult> {
    if (change.kind === "untracked") return untrackedDiff(path.join(root, change.rel));
    const git = findGit();
    if (!git) return {error: "git을 찾을 수 없습니다"};
    // 이름 변경은 두 경로를 다 넘겨야 git이 같은 파일로 알아본다
    const paths = change.origRel ? [change.origRel, change.rel] : [change.rel];
    const args = initial
        ? ["diff", "--cached", "--no-ext-diff", "--no-color", "-M", "--", ...paths]
        : ["diff", "HEAD", "--no-ext-diff", "--no-color", "-M", "--", ...paths];
    // 저장소 루트에서 실행한다 — 경로가 루트 기준이다
    const r = await runGit(git, root, args, 8 << 20);
    if (r.code !== 0 && !r.tooBig) return {error: firstLine(r.err) || "차이를 가져오지 못했습니다"};
    const truncated = r.tooBig || r.out.length > MAX_DIFF_CHARS;
    return {text: r.out.length > MAX_DIFF_CHARS ? r.out.slice(0, MAX_DIFF_CHARS) : r.out, truncated};
}
