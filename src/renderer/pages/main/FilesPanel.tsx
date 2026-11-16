import type {ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowsRotate,
    faArrowUpRightFromSquare,
    faChevronDown,
    faChevronRight,
    faCode,
    faCodeBranch,
    faCopy,
    faEraser,
    faFile,
    faFolder,
    faFolderOpen,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {copyText} from "../../clipboard";
import {highlightFile} from "../../highlight";
import {middleTruncate, ToolDiff} from "./ActivityPanel";
import {FILES_PANEL_MIN_WIDTH, readPref, writePref} from "./files-panel-prefs";

const cx = classNames.bind(styles);

// ── 경로 (macOS·Linux 기준 "/" 구분) ──
function baseName(p: string): string {
    return p.slice(p.lastIndexOf("/") + 1);
}

function dirName(p: string): string {
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "/";
}

function isUnder(base: string, p: string): boolean {
    return !!base && (p === base || p.startsWith(base.endsWith("/") ? base : base + "/"));
}

function relPath(base: string, p: string): string {
    return isUnder(base, p) ? p.slice(base.length).replace(/^\//, "") : p;
}

// 이름이 길면 가운데를 줄인다 — 끝 tail 글자(확장자 쪽, 경로면 파일 이름)는 항상 보이게
const NAME_TAIL = 8;
function NameText({name, tail = NAME_TAIL}: {name: string; tail?: number}) {
    if (name.length <= tail + 4) return <span className={cx("treeName")}>{name}</span>;
    return (
        <span className={cx("treeName")}>
            <span className={cx("treeNameHead")}>{name.slice(0, -tail)}</span>
            <span className={cx("treeNameTail")}>{name.slice(-tail)}</span>
        </span>
    );
}

// 작업 폴더 밖 파일은 전체 경로로 보여 준다 — 홈은 ~로 줄이고, 파일 이름은 잘리지 않게
function homeOf(cwd: string): string | null {
    return /^\/(?:Users|home)\/[^/]+/.exec(cwd)?.[0] ?? null;
}

function displayPath(p: string, home: string | null): string {
    return home && isUnder(home, p) ? "~" + p.slice(home.length) : p;
}

// ── Git 변경 ──
const GIT_KIND_LABEL: Record<GitChangeKind, string> = {
    modified: "수정",
    added: "추가",
    deleted: "삭제",
    renamed: "이름 변경",
    copied: "복사",
    typechange: "종류 변경",
    untracked: "새 파일",
    conflict: "충돌",
};

function gitTitle(f: GitChange, cwd: string): string {
    const parts = [f.path, GIT_KIND_LABEL[f.kind] + (f.origPath ? ` (원래 ${relPath(cwd, f.origPath)})` : "")];
    if (f.kind === "untracked") parts.push("아직 git에 추가하지 않은 파일");
    else if (f.staged && f.unstaged) parts.push("일부만 스테이징됨");
    else if (f.staged) parts.push("스테이징됨");
    return parts.join("\n");
}

type DiffRow =
    | {kind: "hunk"; text: string}
    | {kind: "note"; text: string}
    | {kind: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number};

// git diff(unified) 출력 → 줄 번호가 붙은 행. 첫 @@ 앞의 머리말(diff --git, index, ---, +++)은 건너뛰고
// 바이너리 표시와 권한(mode)만 바뀐 경우만 알아 둔다.
function parseUnifiedDiff(text: string): {rows: DiffRow[]; binary: boolean; modeOnly: boolean} {
    const rows: DiffRow[] = [];
    let oldNo = 0;
    let newNo = 0;
    let inHunk = false;
    let binary = false;
    let modeChange = false;
    for (const line of text.split("\n")) {
        if (line.startsWith("@@")) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (m) {
                oldNo = Number(m[1]);
                newNo = Number(m[2]);
                inHunk = true;
                rows.push({kind: "hunk", text: line});
                continue;
            }
        }
        if (line.startsWith("diff --git ")) {
            inHunk = false;
            continue;
        }
        if (!inHunk) {
            if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
            if (line.startsWith("old mode ") || line.startsWith("new mode ")) modeChange = true;
            continue;
        }
        const c = line[0];
        if (c === "+") rows.push({kind: "add", text: line.slice(1), newNo: newNo++});
        else if (c === "-") rows.push({kind: "del", text: line.slice(1), oldNo: oldNo++});
        else if (c === " ") rows.push({kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++});
        else if (c === "\\") rows.push({kind: "note", text: line.slice(2)});
    }
    return {rows, binary, modeOnly: modeChange && rows.length === 0};
}

// 아주 큰 diff는 앞부분만 그린다 (화면이 멈추지 않게)
const MAX_DIFF_ROWS = 5000;

function GitDiffView({tabId, filePath, entry, version}: {tabId: string; filePath: string; entry: GitChange; version: number}) {
    const [diff, setDiff] = useState<GitDiffResult | null>(null);

    useEffect(() => {
        setDiff(null);
    }, [filePath]);

    // git 상태를 다시 읽을 때마다(version) 같이 다시 읽는다 — 그사이 파일이 또 바뀌었을 수 있다.
    // 새 결과가 올 때까지 이전 화면을 그대로 둔다(깜빡이지 않게).
    useEffect(() => {
        let alive = true;
        void window.electronAPI.gitDiff(tabId, filePath).then((d) => alive && setDiff(d));
        return () => {
            alive = false;
        };
    }, [filePath, version]);

    const parsed = useMemo(() => (diff?.text != null ? parseUnifiedDiff(diff.text) : null), [diff]);
    const binary = !!diff?.binary || !!parsed?.binary;
    const notice = (text: string) => <div className={cx("viewerNotice")}>{text}</div>;

    let empty: string | null = null;
    if (parsed && parsed.rows.length === 0 && !binary) {
        if (entry.kind === "renamed" || entry.kind === "copied") empty = "내용은 그대로이고 이름만 바뀌었습니다";
        else if (parsed.modeOnly) empty = "내용은 그대로이고 실행 권한(모드)만 바뀌었습니다";
        else if (entry.kind === "untracked") empty = "빈 파일입니다";
        else empty = "보여줄 차이가 없습니다";
    }

    return (
        <div className={cx("gitDiffView")}>
            {!diff && notice("불러오는 중…")}
            {diff?.error && notice(diff.error)}
            {entry.origPath && notice(`이름 변경: ${baseName(entry.origPath)} → ${baseName(entry.path)}`)}
            {entry.kind === "untracked" && notice("아직 git에 추가하지 않은 새 파일이라 내용 전체가 추가된 줄로 보입니다")}
            {entry.kind === "conflict" && notice("병합 충돌이 난 파일입니다 — <<<<<<< ~ >>>>>>> 사이를 정리해야 합니다")}
            {binary && notice("텍스트 파일이 아니라 차이를 보여줄 수 없습니다")}
            {diff?.truncated && notice("변경이 커서 앞부분만 보여줍니다")}
            {empty && notice(empty)}
            {parsed && parsed.rows.length > 0 && (
                <div className={cx("gitDiff")}>
                    {parsed.rows.slice(0, MAX_DIFF_ROWS).map((r, i) =>
                        r.kind === "hunk" ? (
                            <div key={i} className={cx("gitDiffHunk")}>
                                {r.text}
                            </div>
                        ) : r.kind === "note" ? (
                            <div key={i} className={cx("gitDiffNote")}>
                                {r.text === "No newline at end of file" ? "파일 끝에 줄바꿈 없음" : r.text}
                            </div>
                        ) : (
                            <div
                                key={i}
                                className={cx("gitDiffRow", {
                                    gitDiffAdd: r.kind === "add",
                                    gitDiffDel: r.kind === "del",
                                })}
                            >
                                <span className={cx("gitDiffNo")}>{r.oldNo ?? ""}</span>
                                <span className={cx("gitDiffNo")}>{r.newNo ?? ""}</span>
                                <span className={cx("gitDiffMarker")}>
                                    {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
                                </span>
                                <span className={cx("gitDiffText")}>{r.text || " "}</span>
                            </div>
                        )
                    )}
                    {parsed.rows.length > MAX_DIFF_ROWS &&
                        notice(`줄이 많아 처음 ${MAX_DIFF_ROWS.toLocaleString()}줄만 보여줍니다`)}
                </div>
            )}
        </div>
    );
}

const TOOL_LABEL: Record<string, string> = {
    Edit: "수정",
    MultiEdit: "여러 곳 수정",
    Write: "새로 쓰기",
    NotebookEdit: "노트북 수정",
};

// 오늘 한 수정은 시각만, 그 전 것은 날짜도. 0 = 시각을 모름(세션 기록에 없음)
function formatTime(at: number): string {
    if (!at) return "";
    const d = new Date(at);
    if (d.toDateString() === new Date().toDateString()) {
        return d.toLocaleTimeString("ko-KR", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
    }
    return d.toLocaleString("ko-KR", {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
}

// ── 파일 보기: 내용 / 이 대화에서 Claude가 한 수정 / 마지막 커밋 이후 Git 변경 ──
type ViewerTab = "content" | "claude" | "git";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 그림 파일 — 패널 폭에 맞춰 보여 준다. 패널보다 큰 그림만 누르면 실제 크기(스크롤)와 오간다.
function ImageView({tabId, filePath, size, version}: {tabId: string; filePath: string; size?: number; version: string}) {
    const [src, setSrc] = useState<string | null | undefined>(undefined);
    // shrunk: 패널에 맞추느라 줄여 그렸다 (작은 그림은 원래 크기 그대로라 오갈 것이 없다)
    const [dims, setDims] = useState<{w: number; h: number; shrunk: boolean} | null>(null);
    const [actual, setActual] = useState(false);
    useEffect(() => {
        let alive = true;
        setSrc(undefined);
        setDims(null);
        setActual(false);
        void window.electronAPI.readImage(tabId, filePath).then((u) => alive && setSrc(u));
        return () => {
            alive = false;
        };
    }, [tabId, filePath, version]);
    if (src === undefined) return <div className={cx("viewerNotice")}>불러오는 중…</div>;
    if (src === null) return <div className={cx("viewerNotice")}>그림을 불러올 수 없습니다 (너무 크거나 손상된 파일)</div>;
    const zoomable = !!dims?.shrunk;
    return (
        <>
            <div className={cx("imageViewMeta")}>
                {[dims && `${dims.w} × ${dims.h}`, size != null && formatBytes(size)].filter(Boolean).join(" · ")}
                {zoomable && (
                    <span className={cx("imageViewHint")}>{actual ? "실제 크기 · 누르면 패널에 맞춥니다" : "줄여서 보는 중 · 누르면 실제 크기"}</span>
                )}
            </div>
            <div className={cx("imageViewScroll")}>
                <img
                    className={cx("imageViewImg", {imageViewZoomable: zoomable, imageViewActual: actual})}
                    src={src}
                    alt=""
                    draggable={false}
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        setDims({w: img.naturalWidth, h: img.naturalHeight, shrunk: img.naturalWidth > img.clientWidth + 1});
                    }}
                    onClick={zoomable ? () => setActual((v) => !v) : undefined}
                />
            </div>
        </>
    );
}

interface ViewerProps {
    tabId: string;
    filePath: string;
    cwd: string;
    info?: ChangedFile;
    gitEntry?: GitChange;
    gitVersion: number;
    // 어느 보기에서 눌렀는지에 따라 먼저 보여 줄 탭
    preferTab: ViewerTab;
    reloadToken: number;
    onClose: () => void;
}

function FileViewer({tabId, filePath, cwd, info, gitEntry, gitVersion, preferTab, reloadToken, onClose}: ViewerProps) {
    const [tab, setTab] = useState<ViewerTab>(preferTab);
    const [view, setView] = useState<FileView | null>(null);
    const [hunks, setHunks] = useState<FileHunk[] | null>(null);
    const [copied, setCopied] = useState(false);
    // svg는 그림과 소스를 오간다
    const [svgSource, setSvgSource] = useState(false);
    // Claude가 이 파일을 다시 고치면(또는 새로고침하면) 다시 읽는다
    const version = info?.lastAt ?? 0;
    const changed = info !== undefined;

    useEffect(() => {
        setView(null);
        setHunks(null);
        setSvgSource(false);
    }, [filePath]);

    useEffect(() => {
        let alive = true;
        void window.electronAPI.readFileForView(tabId, filePath).then((v) => alive && setView(v));
        return () => {
            alive = false;
        };
    }, [filePath, version, reloadToken]);

    useEffect(() => {
        if (!changed) return;
        let alive = true;
        void window.electronAPI.getFileChanges(tabId, filePath).then((h) => alive && setHunks(h));
        return () => {
            alive = false;
        };
    }, [filePath, version, changed]);

    useEffect(() => {
        setTab(preferTab);
    }, [filePath, preferTab]);

    // 없는 탭을 보고 있으면 있는 탭으로 (커밋해서 Git 변경에서 빠졌을 때 등)
    useEffect(() => {
        if (tab === "claude" && !changed) setTab(gitEntry ? "git" : "content");
        else if (tab === "git" && !gitEntry) setTab("content");
    }, [tab, changed, gitEntry]);

    const showImage = !!view?.image && !svgSource;
    const code = useMemo(() => {
        if (view?.text == null || showImage) return null;
        // 파일 끝의 줄바꿈은 <pre>가 빈 줄로 그리지 않는다 — 줄 번호도 맞춰 센다
        const lines = Math.max(1, view.text.split("\n").length - (view.text.endsWith("\n") ? 1 : 0));
        return {
            html: highlightFile(view.text, filePath),
            gutter: Array.from({length: lines}, (_, i) => i + 1).join("\n"),
        };
    }, [view, filePath, showImage]);

    // 이 파일을 열 JetBrains IDE (그 프로젝트를 마지막으로 연 IDE) — 없으면 버튼을 숨긴다
    const [ide, setIde] = useState<EditorTarget | null>(null);
    useEffect(() => {
        let alive = true;
        setIde(null);
        void window.electronAPI.resolveEditorTarget(tabId, filePath).then((t) => {
            if (alive) setIde(t);
        });
        return () => {
            alive = false;
        };
    }, [tabId, filePath]);

    const copyPath = () => {
        void copyText(filePath).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        });
    };

    const rel = relPath(cwd, filePath);
    // 작업 폴더 안이면 상대 경로의 폴더, 밖이면 전체 폴더 경로(~ 줄임)
    const folder =
        rel === filePath
            ? displayPath(dirName(filePath), homeOf(cwd))
            : rel.includes("/")
              ? rel.slice(0, rel.lastIndexOf("/"))
              : "";

    return (
        <div className={cx("fileViewer")}>
            <div className={cx("fileViewerHead")}>
                <div className={cx("fileViewerName")} title={filePath}>
                    <NameText name={baseName(filePath)} />
                    {folder && <span className={cx("fileViewerDir")}>{middleTruncate(folder, 60)}</span>}
                </div>
                <div className={cx("fileViewerActions")}>
                    {ide?.ok && (
                        <button onClick={() => void window.electronAPI.openInEditor(tabId, filePath)} title={`${ide.app}에서 열기`}>
                            <FontAwesomeIcon icon={faCode} />
                        </button>
                    )}
                    <button onClick={() => void window.electronAPI.revealFile(tabId, filePath)} title="Finder에서 보기">
                        <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
                    </button>
                    <button onClick={copyPath} title="경로 복사">
                        <FontAwesomeIcon icon={faCopy} />
                    </button>
                    <button onClick={onClose} title="파일 닫기">
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                </div>
            </div>
            <div className={cx("fileViewerTabs")}>
                <button className={cx("fileViewerTab", {active: tab === "content"})} onClick={() => setTab("content")}>
                    내용
                </button>
                {changed && (
                    <button
                        className={cx("fileViewerTab", {active: tab === "claude"})}
                        onClick={() => setTab("claude")}
                        title="이 대화에서 Claude가 수정·쓰기 도구로 한 수정"
                    >
                        Claude 수정
                    </button>
                )}
                {gitEntry && (
                    <button
                        className={cx("fileViewerTab", {active: tab === "git"})}
                        onClick={() => setTab("git")}
                        title="마지막 커밋과 지금 파일의 차이 (누가 바꿨든 전부)"
                    >
                        Git 변경
                    </button>
                )}
                {copied && <span className={cx("fileViewerCopied")}>경로를 복사했습니다</span>}
            </div>
            {tab === "content" ? (
                <div className={cx("codeView")}>
                    {!view && <div className={cx("viewerNotice")}>불러오는 중…</div>}
                    {view?.missing && <div className={cx("viewerNotice")}>파일이 없습니다 (지워졌거나 옮겨졌을 수 있습니다)</div>}
                    {view?.error && <div className={cx("viewerNotice")}>{view.error}</div>}
                    {view?.binary && <div className={cx("viewerNotice")}>텍스트 파일이 아니라 내용을 보여줄 수 없습니다</div>}
                    {view?.image && view.text != null && (
                        <div className={cx("imageViewSwitch")}>
                            <button className={cx("imageViewSwitchBtn", {active: !svgSource})} onClick={() => setSvgSource(false)}>
                                그림
                            </button>
                            <button className={cx("imageViewSwitchBtn", {active: svgSource})} onClick={() => setSvgSource(true)}>
                                소스
                            </button>
                        </div>
                    )}
                    {showImage && (
                        <ImageView tabId={tabId} filePath={filePath} size={view.size} version={`${version}:${reloadToken}`} />
                    )}
                    {view?.truncated && !showImage && <div className={cx("viewerNotice")}>파일이 커서 앞부분 1MB만 보여줍니다</div>}
                    {code && (
                        <div className={cx("codeScroll")}>
                            <pre className={cx("codeGutter")}>{code.gutter}</pre>
                            {/* highlight.js가 글자를 이스케이프해 만든 HTML이다 */}
                            <pre className={cx("codeBody")}>
                                <code className="hljs" dangerouslySetInnerHTML={{__html: code.html}} />
                            </pre>
                        </div>
                    )}
                </div>
            ) : tab === "git" && gitEntry ? (
                <GitDiffView tabId={tabId} filePath={filePath} entry={gitEntry} version={gitVersion} />
            ) : (
                <div className={cx("changesView")}>
                    {hunks === null && <div className={cx("viewerNotice")}>불러오는 중…</div>}
                    {hunks?.length === 0 && <div className={cx("viewerNotice")}>변경 기록이 없습니다</div>}
                    {hunks && hunks.length > 0 && (
                        <div className={cx("viewerNotice")}>
                            이 대화에서 Claude가 한 수정입니다 (최근 것이 위). Bash로 바꾼 내용은 들어 있지 않습니다
                            {gitEntry ? " — 전부 보려면 Git 변경 탭" : ""}.
                        </div>
                    )}
                    {hunks
                        ?.map((h, i) => ({h, n: i + 1}))
                        .reverse()
                        .map(({h, n}) => {
                            const isEdit = h.tool === "Edit" || h.tool === "MultiEdit";
                            return (
                                <div key={n} className={cx("changeItem")}>
                                    <div className={cx("changeHead")}>
                                        #{n} {TOOL_LABEL[h.tool] ?? h.tool}
                                        {h.at > 0 && ` · ${formatTime(h.at)}`}
                                    </div>
                                    <ToolDiff
                                        name={isEdit ? "Edit" : "Write"}
                                        input={isEdit ? {old_string: h.oldText, new_string: h.newText} : {content: h.newText}}
                                    />
                                </div>
                            );
                        })}
                </div>
            )}
        </div>
    );
}

// ── 트리 ──
type Listing = DirListing | "loading" | null; // null = 열 수 없는 폴더

interface TreeNode<T> {
    name: string;
    path: string;
    children: Map<string, TreeNode<T>>;
    file?: T;
}

// "Claude 수정"·"Git 변경" 보기: 바뀐 파일 경로들로 작은 트리를 만든다
function buildTree<T extends {path: string}>(root: string, files: T[]): TreeNode<T> {
    const top: TreeNode<T> = {name: "", path: root, children: new Map()};
    for (const f of files) {
        const parts = relPath(root, f.path).split("/").filter(Boolean);
        let node = top;
        parts.forEach((part, i) => {
            let next = node.children.get(part);
            if (!next) {
                next = {name: part, path: `${node.path === "/" ? "" : node.path}/${part}`, children: new Map<string, TreeNode<T>>()};
                node.children.set(part, next);
            }
            if (i === parts.length - 1) next.file = f;
            node = next;
        });
    }
    return top;
}

// 폴더 먼저, 이름순
function sortedNodes<T>(node: TreeNode<T>): TreeNode<T>[] {
    return [...node.children.values()].sort((a, b) =>
        !!a.file === !!b.file ? a.name.localeCompare(b.name, undefined, {numeric: true}) : a.file ? 1 : -1
    );
}

const INDENT = 14;

type PanelView = "all" | "claude" | "git";

// 예전 "바뀐 파일만" 설정은 "Claude 수정" 보기로 이어받는다
function readView(): PanelView {
    const v = readPref("filesPanel.view");
    if (v === "all" || v === "claude" || v === "git") return v;
    return readPref("filesPanel.onlyChanged") === "1" ? "claude" : "all";
}

// git 상태는 Claude가 파일을 고칠 때마다 다시 읽는다 — 연달아 오면 한 번으로 묶는다
const GIT_REFRESH_DELAY = 300;

interface Props {
    // 보고 있는 탭 — 트리·파일 읽기·Git 상태는 그 탭의 작업 폴더 기준이다
    tabId: string;
    cwd: string;
    changed: ChangedFilesState;
    // 응답이 끝날 때마다 바뀐다 — Bash 등으로 바뀐 파일을 git 상태에 반영하려고 다시 읽는다
    refreshKey: number;
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
}

// 오른쪽 작업 파일 패널: 작업 폴더 트리 + Claude가 이 대화에서 고친 파일 + 마지막 커밋 이후 Git 변경 + 파일 보기
export function FilesPanel({tabId, cwd, changed, refreshKey, width, onResize, onClose}: Props) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [listings, setListings] = useState<Record<string, Listing>>({});
    const [view, setView] = useState<PanelView>(readView);
    const [selected, setSelected] = useState<string | null>(null);
    const [preferTab, setPreferTab] = useState<ViewerTab>("content");
    const [reloadToken, setReloadToken] = useState(0);
    const [git, setGit] = useState<GitStatusResult | null>(null);
    const [gitVersion, setGitVersion] = useState(0);
    const listingsRef = useRef(listings);
    listingsRef.current = listings;
    const gitReqRef = useRef(0);
    const gitTimerRef = useRef<number | null>(null);

    const loadGit = useCallback(() => {
        const id = ++gitReqRef.current;
        void window.electronAPI.gitStatus(tabId).then((res) => {
            if (id !== gitReqRef.current) return; // 그사이 더 새 요청이 나갔다
            setGit(res);
            setGitVersion((v) => v + 1);
        });
    }, [tabId]);

    const scheduleGit = useCallback(
        (delay = GIT_REFRESH_DELAY) => {
            if (gitTimerRef.current != null) window.clearTimeout(gitTimerRef.current);
            gitTimerRef.current = window.setTimeout(() => {
                gitTimerRef.current = null;
                loadGit();
            }, delay);
        },
        [loadGit]
    );

    useEffect(
        () => () => {
            if (gitTimerRef.current != null) window.clearTimeout(gitTimerRef.current);
        },
        []
    );

    // Claude가 고칠 때·응답이 끝날 때 다시 읽는다
    useEffect(() => {
        scheduleGit();
    }, [changed, refreshKey, scheduleGit]);

    // 에디터나 터미널에서 고치고 돌아오면 다시 읽는다
    useEffect(() => {
        const onFocus = () => scheduleGit();
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [scheduleGit]);

    const gitFiles = git?.ok ? git.files : [];
    const gitMap = useMemo(() => new Map(gitFiles.map((f) => [f.path, f])), [gitFiles]);

    const changedMap = useMemo(() => new Map(changed.files.map((f) => [f.path, f])), [changed.files]);
    const insideFiles = useMemo(() => changed.files.filter((f) => isUnder(cwd, f.path)), [changed.files, cwd]);
    const outsideFiles = useMemo(() => changed.files.filter((f) => !isUnder(cwd, f.path)), [changed.files, cwd]);
    // 바뀐 파일을 품은 폴더들 — 접혀 있어도 점으로 알린다
    const changedDirs = useMemo(() => {
        const dirs = new Set<string>();
        for (const f of insideFiles) {
            for (let d = dirName(f.path); isUnder(cwd, d) && !dirs.has(d); d = dirName(d)) {
                dirs.add(d);
                if (d === cwd) break;
            }
        }
        return dirs;
    }, [insideFiles, cwd]);

    const load = useCallback(async (dir: string) => {
        setListings((cur) => (cur[dir] && cur[dir] !== "loading" ? cur : {...cur, [dir]: "loading"}));
        const res = await window.electronAPI.listDir(tabId, dir);
        setListings((cur) => ({...cur, [dir]: res}));
    }, [tabId]);

    // 작업 폴더가 바뀌면 처음부터
    useEffect(() => {
        setExpanded(new Set());
        setListings({});
        setSelected(null);
        setGit(null);
        if (cwd) void load(cwd);
        scheduleGit(0);
    }, [cwd, load, scheduleGit]);

    // Claude가 새 파일을 만들면 트리에 보이게: 이미 읽어 둔 상위 폴더를 다시 읽는다
    const knownChanged = useRef<Set<string>>(new Set());
    useEffect(() => {
        for (const f of insideFiles) {
            if (knownChanged.current.has(f.path)) continue;
            for (let d = dirName(f.path); isUnder(cwd, d); d = dirName(d)) {
                const l = listingsRef.current[d];
                if (l && l !== "loading") void load(d);
                if (d === cwd) break;
            }
        }
        knownChanged.current = new Set(insideFiles.map((f) => f.path));
    }, [insideFiles, cwd, load]);

    const toggleDir = (dir: string) => {
        const opening = !expanded.has(dir);
        setExpanded((cur) => {
            const next = new Set(cur);
            if (opening) next.add(dir);
            else next.delete(dir);
            return next;
        });
        if (opening && !listingsRef.current[dir]) void load(dir);
    };

    const refresh = () => {
        for (const dir of Object.keys(listingsRef.current)) void load(dir);
        setReloadToken((n) => n + 1);
        scheduleGit(0);
    };

    const changeView = (next: PanelView) => {
        setView(next);
        writePref("filesPanel.view", next);
    };

    // 보기마다 먼저 보여 줄 탭: 전체 트리는 내용, 나머지는 그 보기의 변경
    const select = (filePath: string) => {
        setSelected(filePath);
        setPreferTab(view === "git" ? "git" : view === "claude" ? "claude" : "content");
    };

    // 왼쪽 가장자리를 끌어 너비 조절 (패널은 창 오른쪽에 붙어 있다)
    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const move = (ev: PointerEvent) =>
            onResize(
                Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, FILES_PANEL_MIN_WIDTH), window.innerWidth * 0.7))
            );
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    const pad = (depth: number) => ({paddingLeft: 8 + depth * INDENT});

    const fileRow = (key: string, filePath: string, name: string, depth: number, tail?: number) => {
        const info = changedMap.get(filePath);
        const recent = !!info && info.lastTurn === changed.turn;
        return (
            <div
                key={key}
                className={cx("treeRow", {
                    treeRowChanged: !!info,
                    treeRowRecent: recent,
                    treeRowSelected: selected === filePath,
                })}
                style={pad(depth)}
                onClick={() => select(filePath)}
                title={
                    info
                        ? `${filePath}\nClaude가 이 대화에서 ${info.edits}번 수정${recent ? " · 방금 응답에서 바뀜" : ""}`
                        : filePath
                }
            >
                <span className={cx("treeChevron")} />
                <FontAwesomeIcon icon={faFile} className={cx("treeIcon")} />
                <NameText name={name} tail={tail} />
                {info && <span className={cx("treeBadge")}>{recent ? "방금" : `수정 ${info.edits}`}</span>}
            </div>
        );
    };

    const dirRow = (key: string, dirPath: string, name: string, depth: number, open: boolean, onToggle?: () => void) => (
        <div
            key={key}
            className={cx("treeRow", "treeRowDir", {treeRowStatic: !onToggle})}
            style={pad(depth)}
            onClick={onToggle}
            title={dirPath}
        >
            <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} className={cx("treeChevron")} />
            <FontAwesomeIcon icon={open ? faFolderOpen : faFolder} className={cx("treeIcon")} />
            <NameText name={name} />
            {onToggle && changedDirs.has(dirPath) && (
                <span className={cx("treeDot")} title="안에 Claude가 바꾼 파일이 있습니다" />
            )}
        </div>
    );

    const note = (key: string, depth: number, text: string) => (
        <div key={key} className={cx("treeNote")} style={pad(depth)}>
            {text}
        </div>
    );

    // 작업 폴더 전체 트리 — 펼칠 때 그 폴더만 읽는다
    const renderDir = (dir: string, depth: number): ReactElement[] => {
        const l = listings[dir];
        if (l === undefined || l === "loading") return [note(`${dir}:loading`, depth, "불러오는 중…")];
        if (l === null) return [note(`${dir}:error`, depth, "열 수 없는 폴더입니다")];
        const rows: ReactElement[] = [];
        for (const e of l.entries) {
            if (e.isDir) {
                const open = expanded.has(e.path);
                rows.push(dirRow(e.path, e.path, e.name, depth, open, () => toggleDir(e.path)));
                if (open) rows.push(...renderDir(e.path, depth + 1));
            } else {
                rows.push(fileRow(e.path, e.path, e.name, depth));
            }
        }
        if (l.entries.length === 0) rows.push(note(`${dir}:empty`, depth, "비어 있음"));
        if (l.truncated) rows.push(note(`${dir}:more`, depth, "항목이 많아 일부만 보여줍니다"));
        return rows;
    };

    // "Claude 수정" 내역 지우기 — 오래 작업하면 쌓여서 너무 많아진다. 파일은 그대로, 목록과 표시만 비운다.
    const clearChanged = () => {
        const n = changed.files.length;
        if (n === 0) return;
        if (!window.confirm(`Claude 수정 내역 ${n}개를 지울까요?\n파일은 그대로 두고 목록과 '수정' 표시만 지웁니다. 이후 수정부터 다시 쌓입니다.`)) return;
        void window.electronAPI.clearChangedFiles(tabId);
    };

    // "Claude 수정" 보기 맨 위 줄: 몇 개인지(지운 적 있으면 언제 이후인지) + 내역 지우기
    const changedBar = (
        <div key="c:bar" className={cx("changedBar")}>
            <span className={cx("changedSummary")}>
                파일 {changed.files.length}
                {changed.clearedAt ? ` · ${formatTime(changed.clearedAt)}에 지운 뒤` : ""}
            </span>
            <button
                className={cx("changedClearBtn")}
                onClick={clearChanged}
                disabled={changed.files.length === 0}
                title="이 대화의 Claude 수정 내역을 비웁니다 (파일은 그대로)"
            >
                <FontAwesomeIcon icon={faEraser} /> 내역 지우기
            </button>
        </div>
    );

    // "Claude 수정" 트리 — 모두 펼친 채로
    const renderChanged = (node: TreeNode<ChangedFile>, depth: number): ReactElement[] =>
        sortedNodes(node).flatMap((n) =>
            n.file
                ? [fileRow(`c:${n.path}`, n.path, n.name, depth)]
                : [dirRow(`c:${n.path}`, n.path, n.name, depth, true), ...renderChanged(n, depth + 1)]
        );

    const gitRow = (f: GitChange, name: string, depth: number) => (
        <div
            key={`g:${f.path}`}
            className={cx("treeRow", {treeRowSelected: selected === f.path, treeRowGone: f.kind === "deleted"})}
            style={pad(depth)}
            onClick={() => select(f.path)}
            title={gitTitle(f, cwd)}
        >
            <span className={cx("treeChevron")} />
            <FontAwesomeIcon icon={faFile} className={cx("treeIcon")} />
            <NameText name={name} />
            {changedMap.has(f.path) && <span className={cx("treeDot")} title="이 대화에서 Claude도 고친 파일" />}
            {f.added != null && f.deleted != null && f.added + f.deleted > 0 && (
                <span className={cx("gitCounts")}>
                    <span className={cx("gitAdd")}>+{f.added}</span>
                    <span className={cx("gitDel")}>−{f.deleted}</span>
                </span>
            )}
            <span className={cx("gitBadge", `gitBadge-${f.kind}`)}>{GIT_KIND_LABEL[f.kind]}</span>
        </div>
    );

    const renderGitTree = (node: TreeNode<GitChange>, depth: number): ReactElement[] =>
        sortedNodes(node).flatMap((n) =>
            n.file
                ? [gitRow(n.file, n.name, depth)]
                : [dirRow(`g:${n.path}`, n.path, n.name, depth, true), ...renderGitTree(n, depth + 1)]
        );

    const renderGit = (): ReactElement[] => {
        if (!git) return [note("git:loading", 0, "Git 상태를 읽는 중…")];
        // strict가 꺼져 있어 !git.ok로는 실패 쪽 타입으로 좁혀지지 않는다
        if (git.ok === false) {
            const msg =
                git.reason === "not-repo"
                    ? "이 작업 폴더는 git 저장소가 아닙니다"
                    : git.reason === "no-git"
                      ? "git을 찾을 수 없습니다 (Xcode 명령줄 도구나 Homebrew git이 필요합니다)"
                      : `Git 상태를 읽지 못했습니다${git.message ? `: ${git.message}` : ""}`;
            return [note("git:none", 0, msg)];
        }
        const {branch, files} = git;
        const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
        const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
        const rows: ReactElement[] = [
            <div key="git:branch" className={cx("gitBranchRow")}>
                <FontAwesomeIcon icon={faCodeBranch} className={cx("gitBranchIcon")} />
                <span className={cx("gitBranchName")} title={branch.upstream ? `원격: ${branch.upstream}` : undefined}>
                    {branch.head ?? "브랜치 없음 (detached)"}
                </span>
                {branch.initial && <span className={cx("gitBranchMeta")}>첫 커밋 전</span>}
                {!!branch.ahead && (
                    <span className={cx("gitBranchMeta")} title={`${branch.upstream}보다 커밋 ${branch.ahead}개 앞섬 (아직 push 안 함)`}>
                        ↑{branch.ahead}
                    </span>
                )}
                {!!branch.behind && (
                    <span className={cx("gitBranchMeta")} title={`${branch.upstream}보다 커밋 ${branch.behind}개 뒤처짐`}>
                        ↓{branch.behind}
                    </span>
                )}
                {files.length > 0 && (
                    <span className={cx("gitSummary")}>
                        파일 {files.length}
                        {added + deleted > 0 && (
                            <>
                                {" · "}
                                <span className={cx("gitAdd")}>+{added}</span> <span className={cx("gitDel")}>−{deleted}</span>
                            </>
                        )}
                    </span>
                )}
            </div>,
        ];
        if (files.length === 0) rows.push(note("git:clean", 0, "마지막 커밋 이후 바뀐 파일이 없습니다"));
        else rows.push(...renderGitTree(buildTree(cwd, files), 0));
        if (git.truncated) rows.push(note("git:more", 0, "바뀐 파일이 너무 많아 일부만 보여줍니다"));
        return rows;
    };

    return (
        <aside className={cx("filesPanel")} style={{width}}>
            <div className={cx("filesResize")} onPointerDown={startResize} title="끌어서 너비 조절" />
            <div className={cx("filesHeader")}>
                <span className={cx("filesTitle")} title={cwd}>
                    {baseName(cwd) || cwd}
                </span>
                <button className={cx("filesHeaderBtn")} onClick={refresh} title="새로고침">
                    <FontAwesomeIcon icon={faArrowsRotate} />
                </button>
                <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            <div className={cx("filesViews")} role="tablist" aria-label="보기">
                <button
                    role="tab"
                    aria-selected={view === "all"}
                    className={cx("filesViewBtn", {active: view === "all"})}
                    onClick={() => changeView("all")}
                    title="작업 폴더 전체 트리 (Claude가 바꾼 파일은 표시됨)"
                >
                    전체
                </button>
                <button
                    role="tab"
                    aria-selected={view === "claude"}
                    className={cx("filesViewBtn", {active: view === "claude"})}
                    onClick={() => changeView("claude")}
                    title="이 대화에서 Claude가 수정·쓰기 도구로 고친 파일만"
                >
                    Claude 수정
                    {changed.files.length > 0 && <span className={cx("filesViewCount")}>{changed.files.length}</span>}
                </button>
                <button
                    role="tab"
                    aria-selected={view === "git"}
                    className={cx("filesViewBtn", {active: view === "git"})}
                    onClick={() => changeView("git")}
                    title="마지막 커밋 이후 바뀐 파일 전부 — Bash·에디터·다른 대화에서 바꾼 것도 포함"
                >
                    Git 변경
                    {gitFiles.length > 0 && <span className={cx("filesViewCount")}>{gitFiles.length}</span>}
                </button>
            </div>
            <div className={cx("filesTree", {filesTreeShrunk: selected !== null})}>
                {view === "git"
                    ? renderGit()
                    : view === "claude"
                      ? [
                            changedBar,
                            ...(insideFiles.length > 0
                                ? renderChanged(buildTree(cwd, insideFiles), 0)
                                : outsideFiles.length === 0
                                  ? [
                                        note(
                                            "none",
                                            0,
                                            changed.clearedAt
                                                ? "내역을 지운 뒤 Claude가 바꾼 파일이 아직 없습니다"
                                                : "이 대화에서 Claude가 바꾼 파일이 아직 없습니다"
                                        ),
                                    ]
                                  : []),
                        ]
                      : cwd && renderDir(cwd, 0)}
                {view !== "git" && outsideFiles.length > 0 && (
                    <>
                        <div className={cx("treeSection")}>작업 폴더 밖 {outsideFiles.length}</div>
                        {outsideFiles.map((f) =>
                            fileRow(`o:${f.path}`, f.path, displayPath(f.path, homeOf(cwd)), 0, Math.min(baseName(f.path).length + 1, 32))
                        )}
                    </>
                )}
            </div>
            {selected && (
                <FileViewer
                    tabId={tabId}
                    filePath={selected}
                    cwd={cwd}
                    info={changedMap.get(selected)}
                    gitEntry={gitMap.get(selected)}
                    gitVersion={gitVersion}
                    preferTab={preferTab}
                    reloadToken={reloadToken}
                    onClose={() => setSelected(null)}
                />
            )}
        </aside>
    );
}
