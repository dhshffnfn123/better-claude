import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowsRotate,
    faCircleInfo,
    faCircleNotch,
    faFolderOpen,
    faTowerBroadcast,
    faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./HooksTab.module.scss";
import type {ExtensionsTabProps} from "../../../extensions-open";
import {MiddleName} from "../MiddleName";
import {tildePath} from "../../../attachments";

const cx = classNames.bind(styles);

// 훅 탭 — 소유자의 그림: 훅 = 정해진 순간 저절로 도는 센서. 도구를 쓰기 전·답을 마칠 때 같은 순간에 명령이 내 권한으로 돈다.
// 목록은 main(hooks:list)이 CLI에게 묻는다(get_hooks_listing — 터미널 /hooks와 같은 목록). 여기서는 보기만 한다.
// 창은 탭을 옮기거나 새로 열 때마다 이 본문을 새로 그린다 — 마지막 목록은 모듈에 둔다.

const listCache = new Map<string, Extract<HooksList, {ok: true}>>();

// 이벤트 → 언제 도는지 (CLI의 영어 설명은 그 아래 작게)
const EVENT_KO: Record<string, string> = {
    PreToolUse: "도구를 쓰기 직전",
    PostToolUse: "도구를 쓴 직후",
    PostToolUseFailure: "도구가 실패한 직후",
    PostToolBatch: "도구 여러 개를 한 번에 쓴 뒤",
    PermissionDenied: "자동 모드가 도구를 막았을 때",
    Notification: "알림을 보낼 때",
    UserPromptSubmit: "내가 메시지를 보낼 때",
    UserPromptExpansion: "/명령이 프롬프트로 펼쳐질 때",
    SessionStart: "대화를 시작할 때",
    Stop: "Claude가 답을 마치기 직전",
    StopFailure: "API 오류로 답이 끊겼을 때",
    SubagentStart: "에이전트를 띄울 때",
    SubagentStop: "에이전트가 일을 마치기 직전",
    PreCompact: "대화를 요약하기 전",
    PostCompact: "대화를 요약한 뒤",
    PreModelSwitch: "모델을 바꾸기 전",
    PostModelSwitch: "모델이 바뀐 뒤",
    SessionEnd: "대화를 끝낼 때",
    PermissionRequest: "허용을 물을 때",
    Setup: "저장소를 준비할 때 (init·유지보수)",
    TeammateIdle: "팀원이 쉬려 할 때",
    TaskCreated: "작업을 만들 때",
    TaskCompleted: "작업을 마칠 때",
    Elicitation: "MCP 서버가 입력을 청할 때",
    ElicitationResult: "그 입력에 답한 뒤",
    ConfigChange: "설정 파일이 바뀔 때",
    InstructionsLoaded: "지침(CLAUDE.md·규칙)을 읽을 때",
    WorktreeCreate: "작업 트리를 만들 때",
    WorktreeRemove: "작업 트리를 지울 때",
    CwdChanged: "작업 폴더가 바뀐 뒤",
    FileChanged: "지켜보는 파일이 바뀔 때",
    DirectoryAdded: "작업 폴더를 더한 뒤",
    MessageDisplay: "메시지를 보여 줄 때",
};

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "PermissionRequest"]);

const SESSION_MATCH: Record<string, string> = {startup: "새로 시작", resume: "이어 하기", clear: "/clear 뒤", compact: "요약 뒤"};

const TYPE_KO: Record<string, string> = {
    command: "명령 실행",
    prompt: "모델에게 묻기",
    agent: "에이전트",
    http: "HTTP 요청",
    mcp_tool: "MCP 도구",
    callback: "앱 콜백",
};

function sourceInfo(h: HookRow): {label: string; cls: string; tip: string} {
    switch (h.kind) {
        case "user":
            return {label: "개인", cls: "hkSrcMine", tip: "내 설정(settings.json) — 어느 폴더에서나 돕니다"};
        case "local":
            return {label: "이 레포에서 나만", cls: "hkSrcMine", tip: ".claude/settings.local.json — 이 저장소에서 나만 씁니다(보통 git에 올리지 않음)"};
        case "project":
            return {label: "프로젝트", cls: "hkSrcShared", tip: ".claude/settings.json — git으로 함께 씁니다. 다른 사람이 넣었을 수 있습니다"};
        case "plugin":
            return {label: `플러그인 ${(h.plugin ?? "").split("@")[0]}`, cls: "hkSrcPlugin", tip: `플러그인이 건 훅 — ${h.plugin ?? ""}`};
        case "managed":
            return {label: "관리자", cls: "hkSrcMuted", tip: "회사·관리자가 정한 훅 — 끌 수 없습니다"};
        case "session":
            return {label: "이 대화", cls: "hkSrcMuted", tip: "이 대화에만 걸린 훅"};
        case "flag":
            return {label: "실행 옵션", cls: "hkSrcMuted", tip: "CLI를 띄울 때 넘긴 설정"};
        default:
            return {label: h.sourceLabel || h.source, cls: "hkSrcMuted", tip: h.sourceLabel};
    }
}

function matcherLabel(event: string, matcher: string): {main: string; code?: string} {
    const m = matcher.trim();
    if (!m || m === "*") return {main: TOOL_EVENTS.has(event) ? "모든 도구" : "모든 경우"};
    if (event === "SessionStart") return {main: m.split("|").map((x) => SESSION_MATCH[x.trim()] ?? x.trim()).join(" · "), code: m};
    if (TOOL_EVENTS.has(event)) return {main: "도구", code: m};
    return {main: "대상", code: m};
}

function forPlugin(h: HookRow, focus: string): boolean {
    if (h.kind !== "plugin" || !h.plugin) return false;
    return h.plugin === focus || h.plugin.split("@")[0] === focus.split("@")[0];
}

const FILE_KO: Record<string, string> = {user: "개인", project: "프로젝트", local: "이 레포에서 나만", managed: "관리자"};

export function HooksTab({tabId, cwd, focus}: ExtensionsTabProps) {
    const key = `${tabId}\u0000${cwd}`;
    const [list, setList] = useState<HooksList | null>(() => listCache.get(key) ?? null);
    const [loading, setLoading] = useState(true);
    const [onlyPlugin, setOnlyPlugin] = useState<string | null>(focus ?? null);
    const seqRef = useRef(0);

    const load = useCallback(async () => {
        const seq = ++seqRef.current;
        setLoading(true);
        const r: HooksList = await window.electronAPI.listHooks(tabId).catch((e: unknown) => ({ok: false as const, error: String(e)}));
        if (seq !== seqRef.current) return;
        if (r.ok === true) listCache.set(key, r);
        setList((prev) => (r.ok === false && prev?.ok === true ? prev : r));
        setLoading(false);
    }, [tabId, key]);

    useEffect(() => {
        void load();
    }, [load]);

    const data = list?.ok === true ? list : null;
    const shown = useMemo(() => (data ? data.hooks.filter((h) => !onlyPlugin || forPlugin(h, onlyPlugin)) : []), [data, onlyPlugin]);
    const groups = useMemo(() => {
        if (!data) return [];
        const order = data.events.map((e) => e.name);
        const names = [...new Set(shown.map((h) => h.event))].sort((a, b) => {
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        });
        return names.map((name) => ({name, event: data.events.find((e) => e.name === name), rows: shown.filter((h) => h.event === name)}));
    }, [data, shown]);

    const others = data ? data.hooks.filter((h) => h.kind === "project" || h.kind === "plugin").length : 0;
    const reveal = (p: string): void => {
        void window.electronAPI.revealHookFile(tabId, p);
    };

    let body: React.ReactNode;
    if (!list) {
        body = (
            <div className={cx("hkNotice")}>
                <FontAwesomeIcon icon={faCircleNotch} spin /> 이 폴더의 훅을 확인하는 중…
            </div>
        );
    } else if (list.ok === false) {
        body = <div className={cx("hkNotice")}>훅 목록을 받지 못했습니다 — {list.error}</div>;
    } else if (shown.length === 0) {
        body = onlyPlugin ? (
            <div className={cx("hkEmpty")}>
                <FontAwesomeIcon icon={faTowerBroadcast} className={cx("hkEmptyIcon")} />
                <div>
                    <b>{onlyPlugin.split("@")[0]}</b> 플러그인은 훅을 걸지 않았습니다.
                </div>
            </div>
        ) : (
            <div className={cx("hkEmpty")}>
                <FontAwesomeIcon icon={faTowerBroadcast} className={cx("hkEmptyIcon")} />
                <div className={cx("hkEmptyTitle")}>이 폴더에서 도는 훅이 없습니다</div>
                <div className={cx("hkEmptyText")}>
                    훅은 정해진 순간 — 도구를 쓰기 직전, 내가 메시지를 보낼 때, Claude가 답을 마칠 때 같은 때 — 에 저절로 실행되는
                    명령입니다. 예를 들어 파일을 고칠 때마다 포매터를 돌리거나, 위험한 명령을 막거나, 답이 끝나면 알림을 띄웁니다.
                </div>
                <div className={cx("hkEmptyText")}>
                    설정 파일(settings.json)의 <code>hooks</code>에 적거나 플러그인이 넣습니다 — 터미널에서 <code>claude</code>를 열고{" "}
                    <code>/hooks</code>로 볼 수 있습니다.
                </div>
            </div>
        );
    } else {
        body = groups.map((g) => (
            <section key={g.name} className={cx("hkGroup")}>
                <div className={cx("hkGroupHead")}>
                    <span className={cx("hkGroupTitle")}>{EVENT_KO[g.name] ?? g.name}</span>
                    <code className={cx("hkGroupCode")}>{g.name}</code>
                    <span className={cx("hkGroupCount")}>{g.rows.length}</span>
                </div>
                {g.event?.summary && <div className={cx("hkGroupHint")}>{g.event.summary}</div>}
                {g.rows.map((h, i) => (
                    <HookCard key={`${h.source}:${h.matcher}:${h.text}:${i}`} hook={h} onReveal={reveal} />
                ))}
            </section>
        ));
    }

    return (
        <div className={cx("hkTab")}>
            <div className={cx("hkToolbar")}>
                <span className={cx("hkTitle")}>
                    {data ? (
                        <>
                            이 폴더에서 도는 훅 <b>{data.hooks.length}</b>개
                            {data.events.length > 0 && <span className={cx("hkMuted")}> · 순간 {data.events.length}가지</span>}
                        </>
                    ) : (
                        "훅"
                    )}
                </span>
                <button className={cx("hkToolBtn")} onClick={() => void load()} disabled={loading} title="다시 확인 (CLI에 다시 묻습니다)">
                    <FontAwesomeIcon icon={faArrowsRotate} spin={loading} />
                </button>
            </div>
            <div className={cx("hkScroll")}>
                <div className={cx("hkBanner", {hkBannerStrong: others > 0})}>
                    <FontAwesomeIcon icon={faTriangleExclamation} className={cx("hkBannerIcon")} />
                    <div>
                        <b>훅은 정해진 순간 저절로 실행됩니다.</b> 명령 훅은 내 권한으로 이 Mac에서 바로 돌기 때문에, 어디서 온 훅인지 확인하세요.
                        {others > 0 && <> 프로젝트·플러그인 훅 {others}개는 다른 사람이 넣었을 수 있습니다.</>}
                    </div>
                </div>
                <div className={cx("hkNote")}>
                    <FontAwesomeIcon icon={faCircleInfo} />
                    <span>여기서는 보기만 합니다 — 고치려면 그 설정 파일을 열거나 터미널의 /hooks를 씁니다.</span>
                </div>
                {data?.via === "files" && (
                    <div className={cx("hkWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>
                            CLI에게 훅 목록을 받지 못해 설정 파일에서 직접 읽었습니다{data.note ? ` (${data.note})` : ""} — 실제로 도는 것과 다를 수
                            있습니다.
                        </span>
                    </div>
                )}
                {data?.policy?.allDisabled && (
                    <div className={cx("hkWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>
                            지금은 모든 훅이 꺼져 있습니다 (<code>disableAllHooks</code>){data.policy.disabledByPolicy ? " — 관리자 정책" : ""}.
                        </span>
                    </div>
                )}
                {data?.policy?.managedOnly && (
                    <div className={cx("hkWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>관리자 정책으로 관리자가 정한 훅만 돕니다 — 그 훅은 목록에 나오지 않습니다.</span>
                    </div>
                )}
                {data?.safeMode && (
                    <div className={cx("hkWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>안전 모드라 훅이 돌지 않습니다 — {data.safeMode}</span>
                    </div>
                )}
                {data?.bareMode && (
                    <div className={cx("hkWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>설정 파일·플러그인 훅이 꺼진 모드입니다 — {data.bareMode}</span>
                    </div>
                )}
                {data && data.errors.length > 0 && (
                    <div className={cx("hkWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>
                            읽지 못한 설정 파일이 있어 그 안의 훅은 돌지 않습니다:
                            {data.errors.map((e) => (
                                <span key={e} className={cx("hkErrLine")}>
                                    {e}
                                </span>
                            ))}
                        </span>
                    </div>
                )}
                {onlyPlugin && (
                    <div className={cx("hkFilter")}>
                        <span>
                            <b>{onlyPlugin.split("@")[0]}</b> 플러그인의 훅만 보는 중
                        </span>
                        <button className={cx("hkLinkBtn")} onClick={() => setOnlyPlugin(null)}>
                            모두 보기
                        </button>
                    </div>
                )}
                {body}
                {data && (
                    <div className={cx("hkFiles")}>
                        <div className={cx("hkFilesTitle")}>훅을 읽는 설정 파일</div>
                        {data.files.map((f) => (
                            <div key={f.kind} className={cx("hkFileRow")}>
                                <span className={cx("hkFileKind")}>{FILE_KO[f.kind] ?? f.kind}</span>
                                <span className={cx("hkFilePath")} title={f.path}>
                                    <MiddleName name={tildePath(f.path)} />
                                </span>
                                {f.exists ? (
                                    <button className={cx("hkMiniBtn")} onClick={() => reveal(f.path)} title="Finder에서 보기">
                                        <FontAwesomeIcon icon={faFolderOpen} />
                                    </button>
                                ) : (
                                    <span className={cx("hkMuted")}>없음</span>
                                )}
                            </div>
                        ))}
                        <div className={cx("hkFilesNote")}>
                            프로젝트 설정은 작업 폴더 바로 아래 <code>.claude/settings.json</code>입니다 (하위 폴더에서 열면 저장소 루트의 것은 읽지
                            않습니다).
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── 훅 하나 ──
function HookCard({hook: h, onReveal}: {hook: HookRow; onReveal: (p: string) => void}) {
    const [open, setOpen] = useState(false);
    // 세 줄을 넘는지는 그려 보고 안다 — 글자 수로 정하면 딱 세 줄인 글에도 "전체 보기"가 붙었다
    const [over, setOver] = useState(false);
    const textRef = useRef<HTMLPreElement>(null);
    useLayoutEffect(() => {
        const el = textRef.current;
        if (el && !open) setOver(el.scrollHeight > el.clientHeight + 2);
    }, [h.text, open]);
    const src = sourceInfo(h);
    const m = matcherLabel(h.event, h.matcher);
    return (
        <div className={cx("hkCard", {hkCardOff: h.disabled})}>
            <div className={cx("hkCardHead")}>
                <span className={cx("hkMatch")}>
                    {m.main}
                    {m.code && <code className={cx("hkMatchCode")}>{m.code}</code>}
                </span>
                <span className={cx("hkBadge", "hkType")}>{TYPE_KO[h.type] ?? h.type}</span>
                <span className={cx("hkBadge", src.cls)} title={src.tip}>
                    {src.label}
                </span>
                {h.disabled && (
                    <span className={cx("hkBadge", "hkSrcMuted")} title="지금 모드나 정책 때문에 돌지 않습니다">
                        꺼짐
                    </span>
                )}
                {h.file && (
                    <button className={cx("hkMiniBtn", "hkCardReveal")} onClick={() => onReveal(h.file as string)} title={`이 훅이 적힌 파일을 Finder에서 보기 — ${h.file}`}>
                        <FontAwesomeIcon icon={faFolderOpen} /> 파일
                    </button>
                )}
            </div>
            <pre ref={textRef} className={cx("hkText", {hkTextClamp: !open})}>
                {h.text}
            </pre>
            {(over || open) && (
                <button className={cx("hkLinkBtn", "hkMore")} onClick={() => setOpen((v) => !v)}>
                    {open ? "접기" : "전체 보기"}
                </button>
            )}
            {(h.statusMessage || h.timeout !== undefined || h.async || h.once || h.condition) && (
                <div className={cx("hkMeta")}>
                    {h.statusMessage && <span>도는 동안 “{h.statusMessage}”</span>}
                    {h.timeout !== undefined && <span>제한 {h.timeout}초</span>}
                    {h.async && <span>기다리지 않고 뒤에서</span>}
                    {h.once && <span>한 번만</span>}
                    {h.condition && (
                        <span>
                            조건 <code>{h.condition}</code>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
