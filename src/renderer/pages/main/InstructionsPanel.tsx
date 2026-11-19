import {memo, useCallback, useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowLeft,
    faArrowsRotate,
    faBookOpen,
    faCircleInfo,
    faCircleNotch,
    faEye,
    faFloppyDisk,
    faPen,
    faPlus,
    faRotateLeft,
    faTrashCan,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {middleTruncate} from "./ActivityPanel";
import {isImeComposing} from "./ChatInput";
import {FILES_PANEL_MIN_WIDTH} from "./files-panel-prefs";
import {Markdown} from "./MessageItem";
import {ImageViewer} from "./Lightbox";
import {MiddleName} from "./MiddleName";
import {onTab} from "../../tab-events";
import {TabIdContext} from "../../tab-context";

const cx = classNames.bind(styles);

// 지침 패널 (지침 | 기억) — 작업 파일 패널 자리(오른쪽)에 열린다.
// 지침 = Claude가 대화마다 읽는 CLAUDE.md 같은 파일(사람이 씀). 기억 = Claude가 대화하다 스스로 적어 둔 자동 메모리.
// 목록·읽기·저장은 main(instructions:*)이 하고 경로도 main이 검사한다. 고친 내용은 다음 메시지부터 적용된다
// (진행 중인 대화도 — CLI가 바뀐 지침 파일을 다음 요청에 다시 넣는다).

// 이만큼 크면 "큼" — 고칠 때마다 이어 가는 대화에 파일 전체가 다시 들어가는 게 부담이 되는 크기
const BIG_TOKENS = 5000;

const MEMORY_TYPE_LABEL: Record<string, string> = {user: "사용자", feedback: "피드백", project: "프로젝트", reference: "참고"};

const CREATE_INFO: Record<CreatableInstruction["kind"], {title: string; desc: string; placeholder: string}> = {
    user: {
        title: "모든 프로젝트 공통 지침",
        desc: "어느 폴더에서 대화하든 읽습니다",
        placeholder: "모든 프로젝트에서 Claude가 지킬 것을 적습니다.\n예) 답변은 항상 한국어로 한다.",
    },
    project: {
        title: "이 폴더의 프로젝트 지침",
        desc: "이 폴더에서 대화할 때 읽습니다 · git으로 함께 씁니다",
        placeholder: "이 프로젝트에서 Claude가 알아야 할 것을 적습니다.\n예) 빌드는 npm run build, 테스트는 npm test로 한다.",
    },
    local: {
        title: "내 Mac 전용 지침",
        desc: "이 폴더에서 나만 쓰는 지침",
        placeholder: "이 폴더에서 나만 쓰는 지침을 적습니다.\n예) 내 Mac에서는 Node 22를 nvm으로 쓴다.",
    },
};

// 저장하지 않은 고침 — 패널을 닫거나 탭을 옮겨도(패널이 다시 그려져도) 남는다. 경로마다 하나.
const drafts = new Map<string, {text: string; base: number | null}>();

function baseName(p: string): string {
    return p.slice(p.lastIndexOf("/") + 1);
}

function tilde(p: string): string {
    const home = /^\/(?:Users|home)\/[^/]+/.exec(p)?.[0];
    return home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

// 경로를 max 글자로 — 파일 이름은 통째로 두고 폴더 쪽 가운데를 줄인다(끝을 자르면 파일 이름이 가려진다)
function shortPath(p: string, max: number): string {
    const t = tilde(p);
    if (t.length <= max) return t;
    const base = baseName(t);
    const dir = t.slice(0, t.length - base.length);
    const room = max - base.length - 1;
    if (room < 6) return "…/" + base;
    return middleTruncate(dir, room) + base;
}

// 목록에 쓸 이름 — 작업 폴더 안이면 상대 경로, 밖이면 "폴더/파일"
function nameOf(p: string, cwd: string): string {
    if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
    return p.split("/").slice(-2).join("/");
}

// 이름은 앞(폴더 쪽)만 줄이고 파일 이름은 늘 보이게 — 끝을 자르면 같은 CLAUDE.md끼리 구분이 안 된다.
// 파일 이름 자체가 길면 그 앞부분도 줄인다(예전에는 긴 규칙 파일 이름이 옆의 토큰 수 위로 넘쳤다).
function FileName({name}: {name: string}) {
    return (
        <span className={cx("instrName")}>
            <MiddleName name={name} />
        </span>
    );
}

interface Badge {
    label: string;
    cls: string;
}

function kindOf(f: {path: string; type: string}): Badge {
    if (f.type === "AutoMem") return {label: "기억 목록", cls: "instrBadgeMemory"};
    if (f.type === "User") return {label: "공통", cls: "instrBadgeMuted"};
    if (f.type === "Local") return {label: "내 Mac", cls: "instrBadgeMuted"};
    if (f.type === "Managed") return {label: "관리", cls: "instrBadgeMuted"};
    if (f.path.includes("/.claude/rules/")) return {label: "규칙", cls: "instrBadgeRule"};
    // CLAUDE.md 안의 @경로로 불러온 문서
    if (baseName(f.path) !== "CLAUDE.md") return {label: "가져옴", cls: "instrBadgeRule"};
    return {label: "프로젝트", cls: "instrBadgeProject"};
}

function kTokens(n: number): string {
    if (n >= 10_000) return `${Math.round(n / 1000)}K`;
    if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
}

function stripFrontmatter(text: string): string {
    const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return m ? text.slice(m[0].length) : text;
}

// 지침 파일 보기 — 답변과 같은 마크다운(Markdown: 글이 같으면 다시 파싱하지 않는다 — 이 저장소 CLAUDE.md는 68KB다).
// 링크 처리가 답변과 같아야 한다: 그냥 그리면 `[설치](#설치)` 같은 목차 링크가 앱 주소의 # 뒤를 바꿔, 해시 라우터가
// 없는 화면으로 넘어가 앱 전체가 404 화면이 됐다(새로고침해도 그대로 — 검토에서 찾음). 파일 링크는 탭의 폴더 기준이다.
function MarkdownView({text, tabId, baseDir}: {text: string; tabId: string; baseDir: string}) {
    return (
        <TabIdContext.Provider value={tabId}>
            <Markdown text={text} baseDir={baseDir} />
        </TabIdContext.Provider>
    );
}

// 열어 둔 파일 (목록 → 누르면)
interface OpenFile {
    path: string;
    name: string;
    badge: Badge;
    memory?: MemoryItem;
    create?: CreatableInstruction["kind"];
    edit?: boolean; // 처음부터 편집으로
}

// 기억 알림에서 온 경로가 목록의 그 기억인가 — 설정 폴더가 심볼릭 링크면 앞부분 표기가 다를 수 있어 끝(…/<저장소>/memory/<파일>)도 본다
function sameMemory(a: string, b: string): boolean {
    const tail = (p: string) => p.split("/").slice(-3).join("/");
    return a === b || tail(a) === tail(b);
}

interface Props {
    tabId: string;
    cwd: string;
    // main에 이 탭이 열렸다 — 그 전에 물으면 main은 아직 홈 폴더 기준이다
    opened: boolean;
    refreshKey: number;
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
    // 기억 알림을 눌러서 왔다 — 기억 탭에서 이 기억을 연다. 받으면 onFocusDone으로 셸에 알린다(다시 열려도 또 열지 않게).
    focusMemory?: {path: string} | null;
    onFocusDone?: () => void;
}

// 셸은 어느 탭이든 상태가 바뀔 때마다 다시 그려진다 — 이 패널은 받은 값이 같으면 건너뛴다
export const InstructionsPanel = memo(function InstructionsPanel({
    tabId,
    cwd,
    opened,
    refreshKey,
    width,
    onResize,
    onClose,
    focusMemory,
    onFocusDone,
}: Props) {
    const [list, setList] = useState<InstructionsList | null>(null);
    const [loading, setLoading] = useState(false);
    const [view, setView] = useState<"rules" | "memory">(focusMemory ? "memory" : "rules");
    const [open, setOpen] = useState<OpenFile | null>(null);
    const seqRef = useRef(0);

    const load = useCallback(
        async (refresh = false) => {
            const seq = ++seqRef.current;
            setLoading(true);
            const r: InstructionsList = await window.electronAPI
                .listInstructions(tabId, refresh)
                .catch((e: unknown) => ({ok: false as const, error: String(e)}));
            if (seq !== seqRef.current) return;
            setList(r);
            setLoading(false);
        },
        [tabId]
    );

    useEffect(() => {
        if (opened) void load();
    }, [load, opened, refreshKey, cwd]);
    // 이 탭이 다른 폴더의 대화가 되면 열어 둔 파일은 그 폴더 것이 아니다
    useEffect(() => setOpen(null), [cwd]);
    // 앱에서 저장했거나 Claude가 지침·기억 파일을 고쳤다
    useEffect(() => onTab("instructions", tabId, () => void load()), [tabId, load]);

    // 기억 알림을 누르고 왔다 — 기억 탭에서 그 기억을 연다. 목록에 아직 없으면(처음 쓴 기억은 MEMORY.md가 생겨야 목록에
    // 나온다) 목록이 다시 올 때까지 기다린다. 그사이 다른 탭(지침)이나 다른 파일을 열었으면 그만둔다.
    const focusRef = useRef<string | null>(null);
    const [focusSeq, setFocusSeq] = useState(0);
    useEffect(() => {
        if (!focusMemory) return;
        focusRef.current = focusMemory.path;
        setView("memory");
        setOpen(null);
        setFocusSeq((n) => n + 1);
        onFocusDone?.();
    }, [focusMemory, onFocusDone]);
    useEffect(() => {
        const want = focusRef.current;
        if (!want) return;
        if (view !== "memory" || open) {
            focusRef.current = null;
            return;
        }
        if (list?.ok !== true) return;
        const m = list.memories.find((x) => sameMemory(x.path, want));
        if (!m) return;
        focusRef.current = null;
        setOpen({path: m.path, name: m.file, badge: {label: "기억", cls: "instrBadgeMemory"}, memory: m});
    }, [list, focusSeq, view, open]);

    // 왼쪽 가장자리를 끌어 너비 조절 — 작업 파일 패널과 같은 너비를 쓴다
    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const move = (ev: PointerEvent) =>
            onResize(Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, FILES_PANEL_MIN_WIDTH), window.innerWidth * 0.7)));
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

    // 경로는 가운데를 줄여 파일 이름이 보이게 (고정폭 10.5px ≈ 6.4px/글자)
    const pathChars = Math.max(24, Math.floor((width - 56) / 6.4));
    const data = list?.ok === true ? list : null;
    const tokensOf = (p: string) => data?.files.find((f) => f.path === p)?.tokens;

    const removeMemory = async (m: MemoryItem) => {
        if (!window.confirm(`이 기억을 지울까요?\n\n${m.title}\n\n기억 파일과 MEMORY.md 목록의 그 줄을 함께 지웁니다.`)) return;
        const r = await window.electronAPI.deleteMemory(tabId, m.path);
        if (!r.ok) {
            window.alert(`지우지 못했습니다: ${r.error ?? "알 수 없는 오류"}`);
            return;
        }
        drafts.delete(m.path);
        if (open?.path === m.path) setOpen(null);
        void load();
    };

    const openMemory = (m: MemoryItem, edit = false) =>
        setOpen({path: m.path, name: m.file, badge: {label: "기억", cls: "instrBadgeMemory"}, memory: m, edit});

    let body: React.ReactNode = null;
    if (!list || (!data && loading)) {
        body = (
            <div className={cx("viewerNotice")}>
                <FontAwesomeIcon icon={faCircleNotch} spin /> 지침 파일을 확인하는 중…
            </div>
        );
    } else if (list.ok === false) {
        body = <div className={cx("viewerNotice")}>{list.error}</div>;
    } else if (view === "rules") {
        const files = list.files;
        const total = files.reduce((n, f) => n + f.tokens, 0);
        const memTokens = files.filter((f) => f.type === "AutoMem").reduce((n, f) => n + f.tokens, 0);
        const ruleTokens = total - memTokens;
        const start = Math.max(list.startTotal, total, 1);
        const pct = Math.round((total / start) * 100);
        const share = (n: number) => `${Math.min(100, (n / start) * 100)}%`;
        body = (
            <>
                <div className={cx("instrSummary")}>
                    <div className={cx("instrSummaryHead")}>
                        <span>이 대화에 들어가는 지침</span>
                        <b>{total.toLocaleString()} 토큰</b>
                    </div>
                    <div className={cx("instrBar")}>
                        <span className={cx("instrBarRules")} style={{width: share(ruleTokens)}} />
                        <span className={cx("instrBarMemory")} style={{width: share(memTokens)}} />
                    </div>
                    <div className={cx("instrLegend")}>
                        <span>
                            <i className={cx("instrDot", "instrDotRules")} />
                            지침 {kTokens(ruleTokens)}
                        </span>
                        {memTokens > 0 && (
                            <span>
                                <i className={cx("instrDot", "instrDotMemory")} />
                                기억 목록 {kTokens(memTokens)}
                            </span>
                        )}
                        <span>
                            <i className={cx("instrDot")} />
                            시스템 프롬프트·도구 {kTokens(Math.max(0, list.startTotal - total))}
                        </span>
                    </div>
                    <div className={cx("instrSummaryText")}>
                        새 대화 시작 컨텍스트 {kTokens(list.startTotal)} 토큰 중 <b>{pct}%</b>가 지침입니다.
                    </div>
                    <div className={cx("instrNote")}>
                        <FontAwesomeIcon icon={faCircleInfo} />
                        <span>고친 내용은 다음 메시지부터 적용됩니다 (진행 중인 대화도).</span>
                    </div>
                </div>

                <div className={cx("instrSectionTitle")}>대화 시작 때 읽음 · {files.length}</div>
                {files.length === 0 && <div className={cx("instrEmpty")}>이 폴더에서 Claude가 읽는 지침 파일이 없습니다.</div>}
                {files.map((f) => {
                    const badge = kindOf(f);
                    const name = nameOf(f.path, cwd);
                    return (
                        <button
                            key={f.path}
                            className={cx("instrCard")}
                            onClick={() => setOpen({path: f.path, name, badge})}
                            title={f.path}
                        >
                            <span className={cx("instrCardHead")}>
                                <span className={cx("instrBadge", badge.cls)}>{badge.label}</span>
                                <FileName name={name} />
                                {drafts.has(f.path) && <span className={cx("instrDraftDot")} title="저장하지 않은 고침이 있습니다" />}
                                {f.tokens >= BIG_TOKENS && (
                                    <span className={cx("instrBig")} title="큰 파일 — 대화마다 통째로 들어갑니다">
                                        큼
                                    </span>
                                )}
                                <span className={cx("instrTokens")}>{f.tokens.toLocaleString()} 토큰</span>
                            </span>
                            <span className={cx("instrPath")}>
                                <MiddleName name={shortPath(f.path, pathChars)} />
                            </span>
                        </button>
                    );
                })}

                {list.nested.length > 0 && (
                    <>
                        <div className={cx("instrSectionTitle")}>대화 중 불려 옴 · {list.nested.length}</div>
                        {list.nested.map((n) => {
                            const badge = n.path.includes("/.claude/rules/")
                                ? {label: "규칙", cls: "instrBadgeRule"}
                                : {label: "하위 폴더", cls: "instrBadgeProject"};
                            return (
                                <button
                                    key={n.path}
                                    className={cx("instrCard", "instrCardNested")}
                                    onClick={() => setOpen({path: n.path, name: n.display, badge})}
                                    title={n.path}
                                >
                                    <span className={cx("instrCardHead")}>
                                        <span className={cx("instrBadge", badge.cls)}>{badge.label}</span>
                                        <FileName name={n.display} />
                                        {drafts.has(n.path) && <span className={cx("instrDraftDot")} title="저장하지 않은 고침이 있습니다" />}
                                    </span>
                                    <span className={cx("instrTrigger")}>
                                        {n.trigger ? (
                                            <>
                                                ↳ <code className={cx("instrTriggerFile")}>{baseName(n.trigger)}</code> 작업 중에 불려 옴
                                            </>
                                        ) : (
                                            "↳ 대화 도중에 불려 옴"
                                        )}
                                    </span>
                                </button>
                            );
                        })}
                    </>
                )}

                {list.creatable.length > 0 && (
                    <>
                        <div className={cx("instrSectionTitle")}>지침 추가</div>
                        {list.creatable.map((c) => {
                            const info = CREATE_INFO[c.kind];
                            const note =
                                c.kind === "local" && c.gitIgnored === false
                                    ? ".gitignore에 없어 커밋될 수 있습니다"
                                    : c.kind === "local" && c.gitIgnored === true
                                      ? "git에서 제외됨"
                                      : info.desc;
                            return (
                                <button
                                    key={c.kind}
                                    className={cx("instrAdd")}
                                    onClick={() =>
                                        setOpen({
                                            path: c.path,
                                            name: nameOf(c.path, cwd),
                                            badge: kindOf({path: c.path, type: c.kind === "user" ? "User" : c.kind === "local" ? "Local" : "Project"}),
                                            create: c.kind,
                                        })
                                    }
                                    title={c.path}
                                >
                                    <FontAwesomeIcon icon={faPlus} className={cx("instrAddIcon")} />
                                    <span className={cx("instrAddText")}>
                                        <span className={cx("instrAddTitle")}>{info.title}</span>
                                        <span className={cx("instrAddNote", {instrAddWarn: c.kind === "local" && c.gitIgnored === false})}>
                                            {note}
                                        </span>
                                    </span>
                                    <span className={cx("instrAddPath")}>{c.kind === "user" ? tilde(c.path) : nameOf(c.path, cwd)}</span>
                                </button>
                            );
                        })}
                    </>
                )}
            </>
        );
    } else {
        const index = list.files.find((f) => f.type === "AutoMem");
        body = (
            <>
                {list.memories.length === 0 ? (
                    <div className={cx("instrEmpty")}>
                        아직 Claude가 적어 둔 기억이 없습니다. 대화에서 고쳐 달라고 하거나 &quot;기억해 둬&quot;라고 하면 Claude가 여기에
                        적습니다.
                    </div>
                ) : (
                    <>
                        <div className={cx("instrSectionTitle")}>
                            Claude가 스스로 적어 둔 것 · 이 저장소 {list.memories.length}개
                        </div>
                        <div className={cx("memList")}>
                            {list.memories.map((m) => (
                                <div
                                    key={m.path}
                                    className={cx("memRow")}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openMemory(m)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            openMemory(m);
                                        }
                                    }}
                                >
                                    <div className={cx("memMain")}>
                                        <div className={cx("memTitleRow")}>
                                            <span className={cx("memTitle")}>{m.title}</span>
                                            {m.type && (
                                                <span className={cx("instrBadge", "instrBadgeMuted")}>{MEMORY_TYPE_LABEL[m.type] ?? m.type}</span>
                                            )}
                                            {!m.listed && (
                                                <span
                                                    className={cx("instrBadge", "instrBadgeWarn")}
                                                    title="MEMORY.md 목록에 없어 Claude가 이 기억이 있는 줄 모릅니다"
                                                >
                                                    목록에 없음
                                                </span>
                                            )}
                                            {drafts.has(m.path) && <span className={cx("instrDraftDot")} title="저장하지 않은 고침이 있습니다" />}
                                        </div>
                                        {m.hook && <div className={cx("memHook")}>{m.hook}</div>}
                                    </div>
                                    <span className={cx("memActions")}>
                                        <button
                                            className={cx("memActionBtn")}
                                            title="고치기"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openMemory(m, true);
                                            }}
                                        >
                                            <FontAwesomeIcon icon={faPen} />
                                        </button>
                                        <button
                                            className={cx("memActionBtn", "memActionDanger")}
                                            title="지우기"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void removeMemory(m);
                                            }}
                                        >
                                            <FontAwesomeIcon icon={faTrashCan} />
                                        </button>
                                    </span>
                                </div>
                            ))}
                        </div>
                    </>
                )}
                <div className={cx("instrNote", "instrNoteMemory")}>
                    <FontAwesomeIcon icon={faCircleInfo} />
                    <span>
                        Claude는 대화마다 기억 목록(MEMORY.md)만 읽고, 각 기억은 필요할 때 엽니다.
                        {index && (
                            <>
                                {" "}
                                <button
                                    className={cx("instrLink")}
                                    onClick={() => setOpen({path: index.path, name: "MEMORY.md", badge: kindOf(index)})}
                                >
                                    목록 파일 열기
                                </button>
                            </>
                        )}
                    </span>
                </div>
            </>
        );
    }

    return (
        <aside className={cx("filesPanel")} style={{width}}>
            <div className={cx("filesResize")} onPointerDown={startResize} title="끌어서 너비 조절" />
            {open ? (
                <InstructionFileView
                    key={open.path}
                    tabId={tabId}
                    file={open}
                    tokens={tokensOf(open.path)}
                    pathChars={pathChars}
                    onBack={() => setOpen(null)}
                    onClose={onClose}
                    onChanged={() => void load()}
                    onDeleteMemory={removeMemory}
                />
            ) : (
                <>
                    <div className={cx("filesHeader")}>
                        <span className={cx("filesTitle")}>
                            <FontAwesomeIcon icon={faBookOpen} className={cx("instrTitleIcon")} /> 지침 · 기억
                        </span>
                        <button className={cx("filesHeaderBtn")} onClick={() => void load(true)} title="다시 세기" disabled={loading}>
                            <FontAwesomeIcon icon={faArrowsRotate} spin={loading} />
                        </button>
                        <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                            <FontAwesomeIcon icon={faXmark} />
                        </button>
                    </div>
                    <div className={cx("filesViews")}>
                        <button className={cx("filesViewBtn", {active: view === "rules"})} onClick={() => setView("rules")}>
                            지침{data ? ` ${data.files.filter((f) => f.type !== "AutoMem").length}` : ""}
                        </button>
                        <button className={cx("filesViewBtn", {active: view === "memory"})} onClick={() => setView("memory")}>
                            기억{data ? ` ${data.memories.length}` : ""}
                        </button>
                    </div>
                    <div className={cx("instrBody")}>{body}</div>
                </>
            )}
        </aside>
    );
});

// ── 파일 하나: 보기 / 편집 ──
interface FileViewProps {
    tabId: string;
    file: OpenFile;
    tokens?: number;
    pathChars: number;
    onBack: () => void;
    onClose: () => void;
    onChanged: () => void;
    onDeleteMemory: (m: MemoryItem) => Promise<void>;
}

interface Loaded {
    content: string;
    mtimeMs: number | null;
    exists: boolean;
    readOnly: boolean;
}

function InstructionFileView({tabId, file, tokens, pathChars, onBack, onClose, onChanged, onDeleteMemory}: FileViewProps) {
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [text, setText] = useState("");
    const [base, setBase] = useState<number | null>(null);
    const [mode, setMode] = useState<"view" | "edit">(file.create || file.edit ? "edit" : "view");
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<{kind: "ok" | "error"; text: string} | null>(null);
    const [conflict, setConflict] = useState<{exists: boolean} | null>(null);
    const textRef = useRef(text);
    textRef.current = text;

    const read = useCallback(
        async (keepDraft: boolean) => {
            const r: InstructionRead = await window.electronAPI
                .readInstruction(tabId, file.path)
                .catch((e: unknown) => ({ok: false as const, error: String(e)}));
            if (r.ok === false) {
                setError(r.error);
                return;
            }
            setError(null);
            setLoaded({content: r.content, mtimeMs: r.mtimeMs, exists: r.exists, readOnly: r.readOnly});
            const d = keepDraft ? drafts.get(file.path) : undefined;
            if (d) {
                setText(d.text);
                setBase(d.base);
                setMode("edit");
            } else {
                drafts.delete(file.path);
                setText(r.content);
                setBase(r.mtimeMs);
            }
            if (r.readOnly) setMode("view");
            else if (!r.exists) setMode("edit");
        },
        [tabId, file.path]
    );

    useEffect(() => {
        void read(true);
    }, [read]);

    const dirty = loaded !== null && text !== loaded.content;
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    // 다른 곳에서 바뀌었으면(Claude가 기억을 고침 등) 고치는 중이 아닐 때 다시 읽는다. 고치는 중이면 저장할 때 충돌로 알린다.
    useEffect(
        () =>
            onTab("instructions", tabId, () => {
                if (!dirtyRef.current) void read(false);
            }),
        [tabId, read]
    );

    const change = (v: string) => {
        setText(v);
        setStatus(null);
        if (loaded && v !== loaded.content) drafts.set(file.path, {text: v, base});
        else drafts.delete(file.path);
    };

    const save = async (force = false) => {
        if (!loaded || saving) return;
        const content = textRef.current;
        setSaving(true);
        setConflict(null);
        const r: InstructionWrite = await window.electronAPI
            .writeInstruction(tabId, file.path, content, base, force)
            .catch((e: unknown) => ({ok: false as const, error: String(e)}));
        setSaving(false);
        if (r.ok === true) {
            drafts.delete(file.path);
            setLoaded({...loaded, content, mtimeMs: r.mtimeMs, exists: true});
            setBase(r.mtimeMs);
            setStatus({kind: "ok", text: "저장했습니다 — 다음 메시지부터 적용됩니다"});
            onChanged();
        } else if (r.conflict) {
            setConflict({exists: r.exists !== false});
        } else {
            setStatus({kind: "error", text: r.error ?? "저장하지 못했습니다"});
        }
    };

    const revert = () => {
        if (!loaded) return;
        drafts.delete(file.path);
        setText(loaded.content);
        setBase(loaded.mtimeMs);
        setStatus(null);
        setConflict(null);
    };

    const reload = () => {
        drafts.delete(file.path);
        setConflict(null);
        setStatus(null);
        void read(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isImeComposing(e)) return;
        // 한글 입력 상태에서도 ⌘S가 되게 키 위치(code)로도 본다
        if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "s" || e.code === "KeyS")) {
            e.preventDefault();
            void save();
        }
    };

    const exists = loaded?.exists ?? true;
    const readOnly = loaded?.readOnly ?? false;
    const creating = loaded !== null && !exists;
    const big = (tokens ?? 0) >= BIG_TOKENS;
    const shown = file.memory ? stripFrontmatter(text) : text;
    const title = file.memory ? file.memory.title : file.create ? CREATE_INFO[file.create].title : file.name;

    return (
        <>
            <div className={cx("filesHeader")}>
                <button className={cx("filesHeaderBtn")} onClick={onBack} title="목록으로">
                    <FontAwesomeIcon icon={faArrowLeft} />
                </button>
                <span className={cx("filesTitle", "filesTitleRow")}>
                    <span className={cx("instrCrumb")}>{file.memory ? "기억" : "지침"} ›</span>
                    <MiddleName name={title} />
                </span>
                <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            <div className={cx("instrMeta")}>
                <span className={cx("instrBadge", file.badge.cls)}>{file.badge.label}</span>
                {file.memory?.type && (
                    <span className={cx("instrBadge", "instrBadgeMuted")}>{MEMORY_TYPE_LABEL[file.memory.type] ?? file.memory.type}</span>
                )}
                <span className={cx("instrMetaPath")} title={file.path}>
                    <MiddleName name={shortPath(file.path, Math.max(20, pathChars - (tokens != null ? 14 : 0) - 10))} />
                </span>
                {tokens != null && <span className={cx("instrTokens")}>{tokens.toLocaleString()} 토큰</span>}
            </div>
            {loaded && exists && !readOnly && (
                <div className={cx("filesViews")}>
                    <button className={cx("filesViewBtn", {active: mode === "view"})} onClick={() => setMode("view")}>
                        <FontAwesomeIcon icon={faEye} /> 보기
                    </button>
                    <button className={cx("filesViewBtn", {active: mode === "edit"})} onClick={() => setMode("edit")}>
                        <FontAwesomeIcon icon={faPen} /> 편집
                    </button>
                </div>
            )}

            {error ? (
                <div className={cx("viewerNotice")}>{error}</div>
            ) : !loaded ? (
                <div className={cx("viewerNotice")}>
                    <FontAwesomeIcon icon={faCircleNotch} spin /> 읽는 중…
                </div>
            ) : (
                <>
                    {readOnly && <div className={cx("instrHint")}>관리자가 정한 지침이라 여기서 고칠 수 없습니다.</div>}
                    {creating && (
                        <div className={cx("instrHint")}>
                            아직 없는 파일입니다. 내용을 적고 저장하면 만들어집니다
                            {file.create ? ` — ${CREATE_INFO[file.create].desc}.` : "."}
                        </div>
                    )}
                    {mode === "edit" && big && (
                        <div className={cx("instrWarn")}>
                            <FontAwesomeIcon icon={faTriangleExclamation} className={cx("instrWarnIcon")} />
                            <span>
                                큰 파일입니다(약 {kTokens(tokens ?? 0)} 토큰). 저장하면 <b>이어 가는 대화마다</b> 다음 메시지에 이 파일 전체가 한 번
                                더 들어갑니다. 새 대화에는 영향이 없습니다.
                            </span>
                        </div>
                    )}
                    {mode === "edit" && !readOnly ? (
                        <div className={cx("instrEditorWrap")}>
                            <textarea
                                className={cx("instrEditor")}
                                value={text}
                                onChange={(e) => change(e.target.value)}
                                onKeyDown={onKeyDown}
                                spellCheck={false}
                                placeholder={file.create ? CREATE_INFO[file.create].placeholder : ""}
                                autoFocus={creating || !!file.edit}
                            />
                        </div>
                    ) : (
                        <div className={cx("instrViewBody")}>
                            {file.memory && (
                                <div className={cx("memHead")}>
                                    <div className={cx("memHeadTitle")}>{file.memory.title}</div>
                                    {file.memory.hook && <div className={cx("memHeadHook")}>{file.memory.hook}</div>}
                                    {file.memory.modified && (
                                        <div className={cx("memHeadDate")}>{file.memory.modified.slice(0, 10)}에 저장</div>
                                    )}
                                </div>
                            )}
                            {shown.trim() ? (
                                <ImageViewer tabId={tabId}>
                                    <div className={cx("bubble", "markdown", "instrMarkdown")}>
                                        <MarkdownView text={shown} tabId={tabId} baseDir={file.path.slice(0, file.path.lastIndexOf("/"))} />
                                    </div>
                                </ImageViewer>
                            ) : (
                                <div className={cx("instrEmpty")}>비어 있습니다.</div>
                            )}
                        </div>
                    )}
                    {conflict && (
                        <div className={cx("instrConflict")}>
                            <div className={cx("instrConflictMsg")}>
                                <FontAwesomeIcon icon={faTriangleExclamation} className={cx("instrWarnIcon")} />
                                <span>
                                    {conflict.exists
                                        ? "연 뒤에 다른 곳(Claude나 편집기)에서 이 파일이 바뀌었습니다. 다시 불러오면 내 고침은 버려집니다."
                                        : "연 뒤에 이 파일이 지워졌습니다."}
                                </span>
                            </div>
                            <div className={cx("instrConflictActions")}>
                                <button className={cx("instrBtn")} onClick={reload}>
                                    다시 불러오기
                                </button>
                                <button className={cx("instrBtn", "instrBtnDanger")} onClick={() => void save(true)}>
                                    {conflict.exists ? "그래도 덮어쓰기" : "다시 만들기"}
                                </button>
                            </div>
                        </div>
                    )}
                    <div className={cx("instrFooter")}>
                        <span className={cx("instrStatus", {instrStatusError: status?.kind === "error"})}>
                            {saving ? (
                                "저장하는 중…"
                            ) : status ? (
                                status.text
                            ) : dirty ? (
                                <>
                                    <i className={cx("instrDraftDot")} /> 저장 안 함
                                </>
                            ) : null}
                        </span>
                        {file.memory && exists && mode === "view" && (
                            <button className={cx("instrBtn", "instrBtnDanger")} onClick={() => file.memory && void onDeleteMemory(file.memory)}>
                                <FontAwesomeIcon icon={faTrashCan} /> 지우기
                            </button>
                        )}
                        {dirty && (
                            <button className={cx("instrBtn")} onClick={revert}>
                                <FontAwesomeIcon icon={faRotateLeft} /> 되돌리기
                            </button>
                        )}
                        {!readOnly && (mode === "edit" || dirty) && (
                            <button
                                className={cx("instrBtn", "instrBtnPrimary")}
                                onClick={() => void save()}
                                disabled={saving || (exists ? !dirty : !text.trim())}
                            >
                                <FontAwesomeIcon icon={faFloppyDisk} /> 저장 <span className={cx("instrKbd")}>⌘S</span>
                            </button>
                        )}
                    </div>
                </>
            )}
        </>
    );
}
