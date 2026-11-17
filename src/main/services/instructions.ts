import fs from "fs";
import os from "os";
import path from "path";
import {StringDecoder} from "string_decoder";
import {randomUUID} from "crypto";

// 지침 패널(지침 | 기억)이 다루는 파일들.
// 어떤 지침 파일을 읽는지는 CLI에게 묻는다(main.ts — getContextUsage().memoryFiles). 여기는 파일 다루기만 한다:
// 자동 메모리(기억) 목록 읽기, 대화 기록에서 "대화 중 불려 온 지침" 찾기, 저장(원자적), 기억 지우기.

// CLI 설정 폴더 — 사용자 공통 지침(CLAUDE.md)과 대화 기록(projects/)이 여기 있다
export function claudeConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// 지침 파일로 다루는 최대 크기 — CLAUDE.md가 이보다 크면 패널에서 열지 않는다
export const MAX_INSTRUCTION_BYTES = 2 * 1024 * 1024;

// ── 기억 (자동 메모리) ──
// 폴더 = ~/.claude/projects/<저장소>/memory/. MEMORY.md가 목록이고(대화마다 이것만 읽는다), 기억 하나가 파일 하나다.
// 목록 한 줄: "- [제목](파일.md) — 한 줄 설명". 파일은 frontmatter(name, description, metadata.type …) + 본문.

export interface MemoryItem {
    path: string;
    file: string;
    title: string;
    hook: string;
    type?: string; // user | feedback | project | reference
    modified?: string;
    listed: boolean; // MEMORY.md 목록에 있다
}

const INDEX_LINE_RE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[—–-]+\s*(.*))?$/;

// 간단한 frontmatter 읽기 — 패널에 필요한 키(name, description, type, modified)만. 들여쓴 키(metadata 아래)도 이름으로 읽는다.
export function parseFrontmatter(text: string): {fields: Record<string, string>; body: string} {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return {fields: {}, body: text};
    const fields: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const value = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
        if (value && !(kv[1] in fields)) fields[kv[1]] = value;
    }
    return {fields, body: text.slice(m[0].length)};
}

export async function listMemories(dir: string): Promise<MemoryItem[]> {
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith(".md") && n !== "MEMORY.md");
    } catch {
        return [];
    }
    const index = new Map<string, {title: string; hook: string; order: number}>();
    try {
        const text = await fs.promises.readFile(path.join(dir, "MEMORY.md"), "utf8");
        let order = 0;
        for (const line of text.split(/\r?\n/)) {
            const m = INDEX_LINE_RE.exec(line);
            if (!m) continue;
            const file = path.basename(m[2]);
            if (!index.has(file)) index.set(file, {title: m[1].trim(), hook: (m[3] ?? "").trim(), order: order++});
        }
    } catch {
        // 목록 파일이 없다 — 파일만 보여 준다
    }
    const items = await Promise.all(
        names.map(async (file) => {
            const p = path.join(dir, file);
            let fields: Record<string, string> = {};
            try {
                fields = parseFrontmatter((await fs.promises.readFile(p, "utf8")).slice(0, 64 * 1024)).fields;
            } catch {
                // 읽지 못한 파일은 이름만
            }
            const ix = index.get(file);
            return {
                item: {
                    path: p,
                    file,
                    title: ix?.title || fields.name || file.replace(/\.md$/, ""),
                    hook: ix?.hook || fields.description || "",
                    type: fields.type,
                    modified: fields.modified,
                    listed: !!ix,
                },
                order: ix?.order ?? Number.MAX_SAFE_INTEGER,
            };
        })
    );
    items.sort((a, b) => a.order - b.order || a.item.file.localeCompare(b.item.file));
    return items.map((x) => x.item);
}

// 기억을 지우면 MEMORY.md의 그 줄도 지운다 — 남겨 두면 Claude가 없는 파일을 찾는다
export async function removeFromIndex(dir: string, file: string): Promise<void> {
    const indexPath = path.join(dir, "MEMORY.md");
    let text: string;
    try {
        text = await fs.promises.readFile(indexPath, "utf8");
    } catch {
        return;
    }
    const lines = text.split("\n");
    const kept = lines.filter((line) => {
        const m = INDEX_LINE_RE.exec(line);
        return !(m && path.basename(m[2]) === file);
    });
    if (kept.length !== lines.length) await writeFileAtomic(indexPath, kept.join("\n"));
}

// ── 저장 ──
// 임시 파일에 쓰고 rename으로 바꿔 끼운다(쓰다 만 파일이 남지 않게). 심볼릭 링크면 링크가 가리키는 실제 파일을
// 바꾼다 — 링크 자리에 일반 파일을 덮으면 CLAUDE.md → AGENTS.md 같은 연결이 끊긴다.
export async function writeFileAtomic(p: string, content: string): Promise<number> {
    let target = p;
    let mode = 0o644;
    try {
        target = await fs.promises.realpath(p);
        mode = (await fs.promises.stat(target)).mode & 0o777;
    } catch {
        // 새 파일
    }
    // 폴더는 만들지 않는다 — 지워진 작업 폴더를 되살리지 않게 (호출하는 쪽이 폴더가 있는지 본다)
    const dir = path.dirname(target);
    const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
    try {
        await fs.promises.writeFile(tmp, content, {encoding: "utf8", mode});
        await fs.promises.rename(tmp, target);
    } catch (e) {
        await fs.promises.rm(tmp, {force: true}).catch(() => undefined);
        throw e;
    }
    return (await fs.promises.stat(target)).mtimeMs;
}

// ── 대화 중에 불려 온 지침 ──
// 하위 폴더의 CLAUDE.md(그 폴더 파일을 읽을 때)와 paths가 있는 .claude/rules 규칙(맞는 파일을 건드릴 때)은 대화 시작
// 목록(memoryFiles)에 없다. CLI가 대화 기록에 attachment {type: "nested_memory", path, displayPath}로 남기므로 거기서
// 찾는다(실측). 무엇 때문에 불려 왔는지는 기록에 없어서 경로로 찾는다: 하위 폴더 CLAUDE.md는 그 폴더 안 파일, 규칙은
// paths 패턴에 맞는 파일 중 가장 최근에 Claude가 다룬 것. "바로 앞 도구"로 보면 여러 파일을 한 번에 읽을 때 틀렸다(재현됨).

export interface NestedInstruction {
    path: string;
    display: string;
    trigger?: string;
    at?: number;
}

const transcriptPaths = new Map<string, string>();

function findTranscript(sid: string): string | null {
    const known = transcriptPaths.get(sid);
    if (known && fs.existsSync(known)) return known;
    const root = path.join(claudeConfigDir(), "projects");
    let dirs: string[];
    try {
        dirs = fs.readdirSync(root);
    } catch {
        return null;
    }
    for (const d of dirs) {
        const p = path.join(root, d, `${sid}.jsonl`);
        if (fs.existsSync(p)) {
            transcriptPaths.set(sid, p);
            return p;
        }
    }
    return null;
}

const TOOL_PATH_KEYS = ["file_path", "path", "notebook_path"];

// 규칙 파일 frontmatter의 paths — 목록("- a"), 한 줄 배열(["a", "b"]), 값 하나 모두 읽는다
export function ruleGlobs(text: string): string[] {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return [];
    const out: string[] = [];
    const push = (v: string) => {
        const t = v.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
        if (t) out.push(t);
    };
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^paths:\s*(.*)$/.exec(lines[i]);
        if (!kv) continue;
        const inline = kv[1].trim();
        if (inline.startsWith("[")) inline.replace(/^\[|\]$/g, "").split(",").forEach(push);
        else if (inline) push(inline);
        else for (let j = i + 1; j < lines.length && /^\s*-\s*/.test(lines[j]); j++) push(lines[j].replace(/^\s*-\s*/, ""));
    }
    return out;
}

function globToRegExp(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            i++;
            if (glob[i + 1] === "/") {
                i++;
                re += "(?:.*/)?";
            } else {
                re += ".*";
            }
        } else if (c === "*") {
            re += "[^/]*";
        } else if (c === "?") {
            re += "[^/]";
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${re}(?:/.*)?$`);
}

function findLast(list: string[], ok: (f: string) => boolean): string | undefined {
    for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return list[i];
    return undefined;
}

// 불려 온 지침 p의 계기 — recent: Claude가 다룬 파일(결과가 온 순서)
function triggerFor(p: string, recent: string[]): string | undefined {
    const base = path.basename(p);
    if (base === "CLAUDE.md" || base === "CLAUDE.local.md") {
        const dir = path.dirname(p);
        const scope = path.basename(dir) === ".claude" ? path.dirname(dir) : dir;
        return findLast(recent, (f) => f.startsWith(scope + path.sep)) ?? recent[recent.length - 1];
    }
    const marker = `${path.sep}.claude${path.sep}rules${path.sep}`;
    const i = p.indexOf(marker);
    if (i >= 0) {
        const root = p.slice(0, i);
        let globs: string[] = [];
        try {
            globs = ruleGlobs(fs.readFileSync(p, "utf8").slice(0, 16 * 1024));
        } catch {
            // 읽지 못하면 아래로
        }
        const res = globs.map(globToRegExp);
        const hit = findLast(recent, (f) => f.startsWith(root + path.sep) && res.some((re) => re.test(path.relative(root, f))));
        if (hit) return hit;
    }
    return recent[recent.length - 1];
}

// 대화 기록은 뒤에 붙기만 한다 — 대화마다 지난번에 읽은 곳(offset)부터 이어 읽는다. 처음부터 다시 읽으면 긴 대화
// (이 Mac에 118MB짜리가 있다)에서 답변이 끝날 때마다 기록 전체를 훑었다. 파일이 작아졌으면(다시 쓰임) 처음부터.
interface NestedScan {
    file: string;
    offset: number;
    decoder: StringDecoder; // 읽은 조각 끝에서 잘린 한글 바이트를 다음 조각과 잇는다
    rest: string; // 아직 줄바꿈이 오지 않은 마지막 줄
    items: Map<string, NestedInstruction>;
    toolFiles: Map<string, string>;
    recent: string[];
    busy: Promise<void>;
}

const nestedScans = new Map<string, NestedScan>();
const READ_CHUNK = 1 << 20;

function scanLine(scan: NestedScan, line: string) {
    const nested = line.includes('"nested_memory"');
    if (!nested && !line.includes('"tool_use"') && !line.includes('"tool_result"')) return;
    let e: {
        type?: string;
        timestamp?: string;
        cwd?: string;
        message?: {content?: unknown};
        attachment?: {type?: string; path?: unknown; displayPath?: unknown};
    };
    try {
        e = JSON.parse(line);
    } catch {
        return;
    }
    if (e.type === "attachment" && e.attachment?.type === "nested_memory" && typeof e.attachment.path === "string") {
        const p = e.attachment.path;
        if (!scan.items.has(p)) {
            scan.items.set(p, {
                path: p,
                display: typeof e.attachment.displayPath === "string" ? e.attachment.displayPath : path.basename(p),
                trigger: triggerFor(p, scan.recent),
                at: e.timestamp ? Date.parse(e.timestamp) || undefined : undefined,
            });
        }
        return;
    }
    const content = e.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as {type?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string}[]) {
        if (b?.type === "tool_use" && b.id && b.input) {
            const k = TOOL_PATH_KEYS.find((key) => typeof b.input?.[key] === "string");
            if (k) scan.toolFiles.set(b.id, path.resolve(e.cwd ?? "/", b.input[k] as string));
        } else if (b?.type === "tool_result" && b.tool_use_id) {
            const f = scan.toolFiles.get(b.tool_use_id);
            if (f) {
                scan.recent.push(f);
                if (scan.recent.length > 400) scan.recent.splice(0, scan.recent.length - 200);
            }
        }
    }
}

async function readMore(scan: NestedScan) {
    let size: number;
    try {
        size = (await fs.promises.stat(scan.file)).size;
    } catch {
        return;
    }
    if (size < scan.offset) {
        Object.assign(scan, {offset: 0, decoder: new StringDecoder("utf8"), rest: "", items: new Map(), toolFiles: new Map(), recent: []});
    }
    if (size <= scan.offset) return;
    const fh = await fs.promises.open(scan.file, "r");
    try {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - scan.offset));
        while (scan.offset < size) {
            const {bytesRead} = await fh.read(buf, 0, Math.min(buf.length, size - scan.offset), scan.offset);
            if (bytesRead <= 0) break;
            scan.offset += bytesRead;
            const lines = (scan.rest + scan.decoder.write(buf.subarray(0, bytesRead))).split("\n");
            scan.rest = lines.pop() ?? "";
            for (const line of lines) scanLine(scan, line);
        }
    } finally {
        await fh.close();
    }
}

export async function nestedFromTranscript(sid: string): Promise<NestedInstruction[]> {
    const file = findTranscript(sid);
    if (!file) return [];
    let scan = nestedScans.get(sid);
    if (!scan || scan.file !== file) {
        scan = {
            file,
            offset: 0,
            decoder: new StringDecoder("utf8"),
            rest: "",
            items: new Map(),
            toolFiles: new Map(),
            recent: [],
            busy: Promise.resolve(),
        };
        nestedScans.set(sid, scan);
    }
    // 겹쳐 부르면(패널 열기와 변경 알림이 동시에) 같은 부분을 두 번 읽지 않게 차례로 돈다
    const s = scan;
    s.busy = s.busy.then(() => readMore(s)).catch((e) => console.error("[instructions] 대화 기록 읽기 실패", e));
    await s.busy;
    return [...s.items.values()];
}

// 기억 파일 하나(목록 MEMORY.md 말고) — 대화 시작 때 읽는 파일이 아니라서 바뀌어도 다시 셀 필요가 없다
export function isMemoryTopicFile(p: string): boolean {
    const projects = path.join(claudeConfigDir(), "projects") + path.sep;
    return p.startsWith(projects) && p.includes(`${path.sep}memory${path.sep}`) && p.endsWith(".md") && path.basename(p) !== "MEMORY.md";
}

// Claude의 수정(Write/Edit)이 지침·기억 파일을 건드렸는지 — 그러면 패널과 크기 표시를 새로 계산한다
export function isInstructionLike(p: string): boolean {
    const base = path.basename(p);
    if (base === "CLAUDE.md" || base === "CLAUDE.local.md") return true;
    if (p.includes(`${path.sep}.claude${path.sep}rules${path.sep}`)) return true;
    const projects = path.join(claudeConfigDir(), "projects") + path.sep;
    return p.startsWith(projects) && p.includes(`${path.sep}memory${path.sep}`) && p.endsWith(".md");
}
