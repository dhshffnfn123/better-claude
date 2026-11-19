import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowLeft,
    faArrowUpRightFromSquare,
    faCheck,
    faChevronDown,
    faChevronRight,
    faKey,
    faMagnifyingGlass,
    faPuzzlePiece,
    faRotateRight,
    faSpinner,
    faTerminal,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./extensions.module.scss";
import {MiddleName} from "../MiddleName";
import {Switch} from "../NotificationSettings";
import {isImeComposing} from "../ChatInput";
import {type ExtensionsTabProps, openExtensions} from "../../../extensions-open";
import {useExtensionsHost} from "./extensions-host";

const cx = classNames.bind(styles);

// 플러그인 탭 — 설치됨(켜기·끄기·지우기, 안에 든 것·대화마다 드는 토큰, 위험 표시, MCP 로그인) | 찾아보기(마켓플레이스 목록,
// 출처, 범위를 골라 설치). 실제 일은 main이 `claude plugin …`으로 한다(plugins:*). 설정은 터미널의 claude와 같은 곳에 적힌다.

const SCOPE_LABEL: Record<string, string> = {
    user: "모든 프로젝트",
    project: "팀 공유",
    local: "이 레포에서 나만",
    managed: "관리 정책",
};

const OP_WORD: Record<PluginOp["kind"], string> = {install: "설치", enable: "켜기", disable: "끄기", uninstall: "지우기"};

// 찾아보기 목록을 한 번에 그리는 수 — 4천여 개를 다 그리면 무겁다
const PAGE = 120;

type Busy = {kind: PluginOp["kind"]; id: string; startedAt: number};
type Notice = {kind: "ok" | "error"; text: string; detail?: string};
type Confirm = {op: Extract<PluginOp, {kind: "install"}>; command: string; mode?: string; sha256: string};
// 끄기·지우기를 누르면 그 카드 안에서 한 번 더 묻는다
type Pending = {id: string; action: "disable" | "uninstall"};

// 이 폴더에 적용되는 같은 플러그인의 기록들(범위마다 하나)을 한 카드로. 팀 공유로 켠 플러그인을 "나만" 껐다 다시 켜면 그 레포의
// 나만 설정에 기록이 하나 더 생긴다(CLI 실측 — list에 같은 id가 project·local 두 줄) — 두 장으로 보이면 헷갈린다.
interface PluginGroup extends InstalledPlugin {
    scopes: string[]; // 넓은 것부터: managed, user, project, local
}

const SCOPE_ORDER = ["managed", "user", "project", "local"];

function groupHere(records: InstalledPlugin[]): PluginGroup[] {
    const byId = new Map<string, PluginGroup>();
    for (const r of records) {
        const g = byId.get(r.id);
        if (!g) {
            byId.set(r.id, {...r, scopes: [r.scope]});
            continue;
        }
        if (!g.scopes.includes(r.scope)) g.scopes.push(r.scope);
        for (const s of r.mcpServers) if (!g.mcpServers.some((x) => x.name === s.name)) g.mcpServers = [...g.mcpServers, s];
    }
    for (const g of byId.values()) g.scopes.sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b));
    return [...byId.values()];
}

// 창 안의 작은 확인 칸이 열려 있는 동안 Esc는 그 칸만 닫는다 — 창(ExtensionsDialog)보다 먼저 받아(capture) 막는다
function useEscape(active: boolean, onEscape: () => void) {
    const ref = useRef(onEscape);
    ref.current = onEscape;
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.isComposing) return;
            e.preventDefault();
            e.stopPropagation();
            ref.current();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active]);
}

function elapsed(since: number): string {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function tokens(n: number): string {
    return `~${n.toLocaleString()} 토큰`;
}

// MCP 서버가 무엇을 실행하는지 — 이 컴퓨터의 프로그램(stdio) / 원격 서버
function serverWhat(s: {transport: string; target?: string}): string {
    if (s.transport === "stdio") return `이 컴퓨터의 프로그램${s.target ? ` (${s.target})` : ""}`;
    if (s.transport === "http" || s.transport === "sse") {
        let host = s.target ?? "";
        try {
            host = new URL(s.target ?? "").host;
        } catch {
            // 주소 그대로
        }
        return `원격 서버${host ? ` ${host}` : ""}`;
    }
    return s.transport;
}

const MCP_STATUS_LABEL: Record<string, string> = {
    "connected": "연결됨",
    "failed": "연결 실패",
    "needs-auth": "로그인 필요",
    "pending": "연결 중",
    "disabled": "꺼짐",
};

export function PluginsTab({tabId, cwd, focus}: ExtensionsTabProps) {
    const host = useExtensionsHost();
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const [view, setView] = useState<"installed" | "browse">("installed");
    const [list, setList] = useState<PluginListResult | null>(null);
    const [details, setDetails] = useState<Record<string, PluginDetailsResult>>({});
    const [mcp, setMcp] = useState<McpServer[]>([]);
    const [available, setAvailable] = useState<PluginAvailableResult | null>(null);
    const [busy, setBusy] = useState<Busy | null>(null);
    const [, setTick] = useState(0);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [highlight, setHighlight] = useState<string | null>(null);
    const [othersOpen, setOthersOpen] = useState(false);
    // 찾아보기
    const [query, setQuery] = useState("");
    const [market, setMarket] = useState("");
    const [sort, setSort] = useState<"popular" | "name">("popular");
    const [shown, setShown] = useState(PAGE);
    const [detailId, setDetailId] = useState<string | null>(null);
    const [scope, setScope] = useState<PluginScope | null>(null);
    const focusDone = useRef(false);

    // ── 불러오기 ──
    const loadInstalled = useCallback(async () => {
        const r = await window.electronAPI.listPlugins(tabId);
        if (!alive.current) return;
        setList(r);
        if (!r.ok) return;
        // 안에 든 것·토큰은 플러그인마다 CLI를 한 번씩 부른다 (main이 캐시한다) — 셋씩 나란히
        const queue = r.plugins.map((p) => p.id);
        await Promise.all(
            Array.from({length: Math.min(3, queue.length)}, async () => {
                for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
                    const key = id;
                    const d = await window.electronAPI.getPluginDetails(tabId, key);
                    if (alive.current) setDetails((cur) => ({...cur, [key]: d}));
                }
            })
        );
        if (r.plugins.some((p) => p.mcpServers.length > 0)) {
            const status = await window.electronAPI.getMcpStatus(tabId).catch(() => [] as McpServer[]);
            if (alive.current) setMcp(status);
        }
    }, [tabId]);

    const loadAvailable = useCallback(
        async (refresh = false) => {
            if (refresh) setAvailable(null);
            const r = await window.electronAPI.listAvailablePlugins(tabId, refresh);
            if (alive.current) setAvailable(r);
        },
        [tabId]
    );

    useEffect(() => {
        void loadInstalled();
    }, [loadInstalled]);

    useEffect(() => {
        if (view === "browse" && !available) void loadAvailable();
    }, [view, available, loadAvailable]);

    // 진행 중인 바꾸는 명령. 이 화면이 시작한 것(ownOp)은 결과를 직접 받는다. 창을 닫았다 다시 열었을 때처럼 다른 화면이
    // 시작한 것은 main에 1초마다 물어 끝나면 목록을 새로 받는다. 경과 시간을 다시 그리려고 1초마다 tick.
    const ownOp = useRef(false);
    // 다른 화면이 시작한 설치를 여기서 취소했다 — 끝난 걸 알게 되면 그렇게 알린다 (이 화면이 시작한 것은 결과로 알린다)
    const cancelAsked = useRef(false);
    useEffect(() => {
        void window.electronAPI.getPluginBusy().then((b) => {
            if (alive.current && b && !ownOp.current) setBusy(b);
        });
    }, []);
    useEffect(() => {
        if (!busy) return;
        const timer = window.setInterval(() => {
            setTick((n) => n + 1);
            if (ownOp.current) return;
            void window.electronAPI.getPluginBusy().then((b) => {
                if (b || !alive.current || ownOp.current) return;
                setBusy(null);
                if (cancelAsked.current) {
                    cancelAsked.current = false;
                    setNotice({kind: "error", text: "취소했습니다 — 도중에 멈춰서 일부만 바뀌었을 수 있습니다. 목록을 다시 확인하세요"});
                }
                setAvailable(null);
                setDetails({});
                void loadInstalled();
            });
        }, 1000);
        return () => window.clearInterval(timer);
    }, [busy, loadInstalled]);

    // ── 찾아갈 것(focus): 설치돼 있으면 설치됨의 그 줄, 아니면 찾아보기에서 그 글로 찾고 id가 같으면 그 플러그인을 연다 ──
    useEffect(() => {
        if (!focus || focusDone.current || !list) return;
        if (list.ok) {
            const hit = list.plugins.find((p) => p.id === focus || p.name === focus);
            if (hit) {
                focusDone.current = true;
                setView("installed");
                if (!hit.here) setOthersOpen(true);
                setHighlight(hit.id);
                return;
            }
        }
        focusDone.current = true;
        setView("browse");
        setQuery(focus);
    }, [focus, list]);
    const openedFocusDetail = useRef(false);
    useEffect(() => {
        if (!focus || openedFocusDetail.current || view !== "browse" || !available?.ok) return;
        openedFocusDetail.current = true;
        const exact = available.plugins.filter((p) => p.id === focus || p.name === focus);
        if (exact.length === 1) setDetailId(exact[0].id);
    }, [focus, view, available]);

    useEffect(() => {
        if (!highlight || view !== "installed") return;
        const t = window.setTimeout(() => {
            document.querySelector(`[data-plugin-id="${CSS.escape(highlight)}"]`)?.scrollIntoView({block: "center"});
        }, 50);
        const off = window.setTimeout(() => alive.current && setHighlight(null), 2600);
        return () => {
            window.clearTimeout(t);
            window.clearTimeout(off);
        };
    }, [highlight, view, list]);

    // ── 바꾸기 ──
    const run = useCallback(
        async (op: PluginOp) => {
            setPending(null);
            setConfirm(null);
            setNotice(null);
            ownOp.current = true;
            setBusy({kind: op.kind, id: op.id, startedAt: Date.now()});
            const r = await window.electronAPI.runPluginOp(tabId, op);
            ownOp.current = false;
            if (!alive.current) return;
            setBusy(null);
            if (r.ok) {
                setNotice({kind: "ok", text: `${r.message} — 열려 있는 대화에는 다음 메시지부터 적용됩니다`});
                setAvailable(null);
                await loadInstalled();
                if (op.kind === "install" && alive.current) {
                    setDetailId(null);
                    setView("installed");
                    setHighlight(op.id);
                }
                return;
            }
            // (strict가 꺼져 있어 !r.ok로는 좁혀지지 않는다 — === false)
            if (r.ok === false) {
                if (r.confirm && op.kind === "install") {
                    setConfirm({op, ...r.confirm});
                    if (r.detail || r.code !== "command_source_refused") setNotice({kind: "error", text: r.error, detail: r.detail});
                    return;
                }
                setNotice({kind: "error", text: r.error, detail: r.detail});
                if (r.cancelled) void loadInstalled();
            }
        },
        [tabId, loadInstalled]
    );

    useEscape(!!pending, () => setPending(null));
    useEscape(!!confirm, () => setConfirm(null));

    const plugins = list?.ok ? list.plugins : [];
    const here = useMemo(() => groupHere(plugins.filter((p) => p.here)), [plugins]);
    const others = plugins.filter((p) => !p.here);
    const home = list?.ok ? list.home : "";
    const projectRoot = list?.ok ? list.projectRoot : "";
    // 홈 폴더(레포 아님)에서는 레포 범위로 바꾸지 않는다 — 그 "프로젝트 설정"이 사용자 설정 파일과 같다
    const repoOk = !!projectRoot && projectRoot !== home;
    const busyName = busy ? busy.id.split("@")[0] : "";

    return (
        <div className={cx("extPage")}>
            <div className={cx("plugTop")}>
                <div className={cx("plugSeg")} role="tablist" aria-label="플러그인 보기">
                    <button
                        role="tab"
                        aria-selected={view === "installed"}
                        className={cx("plugSegBtn", {plugSegOn: view === "installed"})}
                        onClick={() => setView("installed")}
                    >
                        설치됨{list?.ok ? ` ${here.length}` : ""}
                    </button>
                    <button
                        role="tab"
                        aria-selected={view === "browse"}
                        className={cx("plugSegBtn", {plugSegOn: view === "browse"})}
                        onClick={() => setView("browse")}
                    >
                        찾아보기
                    </button>
                </div>
                <span className={cx("plugTopSpacer")} />
                <button
                    className={cx("extIconBtn")}
                    onClick={() => {
                        setNotice(null);
                        if (view === "browse") void loadAvailable(true);
                        else {
                            setList(null);
                            setDetails({});
                            void loadInstalled();
                        }
                    }}
                    disabled={!!busy}
                    data-tooltip={view === "browse" ? "마켓플레이스 목록 새로 받기" : "설치된 플러그인 다시 읽기"}
                    data-tooltip-dir="down"
                    aria-label="새로 고침"
                >
                    <FontAwesomeIcon icon={faRotateRight} />
                </button>
            </div>
            <p className={cx("extLead")}>
                플러그인은 스킬·에이전트·훅·MCP 서버를 묶어 한 번에 설치하는 키트입니다. 설치·켜기·끄기는 터미널의 claude와 같은 설정에 적혀서
                터미널에서도 똑같이 바뀝니다.
            </p>

            {busy && (
                <div className={cx("extBanner", "extBannerBusy")} role="status">
                    <FontAwesomeIcon icon={faSpinner} spin />
                    <span className={cx("extBannerText")}>
                        {busyName} {OP_WORD[busy.kind]} 중… {elapsed(busy.startedAt)}
                        {busy.kind === "install" && " — 저장소를 받는 동안 시간이 걸릴 수 있습니다"}
                    </span>
                    {busy.kind === "install" && (
                        <button
                            className={cx("extBtn", "extBtnSmall")}
                            onClick={() => {
                                cancelAsked.current = !ownOp.current;
                                void window.electronAPI.cancelPluginOp();
                            }}
                        >
                            취소
                        </button>
                    )}
                </div>
            )}
            {notice && (
                <div className={cx("extBanner", notice.kind === "ok" ? "extBannerOk" : "extBannerError")} role={notice.kind === "error" ? "alert" : "status"}>
                    <FontAwesomeIcon icon={notice.kind === "ok" ? faCheck : faTriangleExclamation} />
                    <span className={cx("extBannerText")}>
                        {notice.text}
                        {notice.detail && <pre className={cx("extBannerDetail")}>{notice.detail}</pre>}
                    </span>
                    <button className={cx("extIconBtn", "extBannerClose")} onClick={() => setNotice(null)} aria-label="알림 닫기">
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                </div>
            )}

            {view === "installed" ? (
                <InstalledView
                    list={list}
                    here={here}
                    others={others}
                    details={details}
                    mcp={mcp}
                    busy={busy}
                    pending={pending}
                    repoOk={repoOk}
                    expanded={expanded}
                    highlight={highlight}
                    othersOpen={othersOpen}
                    onToggleOthers={() => setOthersOpen((v) => !v)}
                    onExpand={(id) =>
                        setExpanded((s) => {
                            const n = new Set(s);
                            if (n.has(id)) n.delete(id);
                            else n.add(id);
                            return n;
                        })
                    }
                    onPending={setPending}
                    onRun={(op) => void run(op)}
                    onBrowse={() => setView("browse")}
                    onLogin={host.openMcp}
                />
            ) : detailId && available?.ok ? (
                <PluginPage
                    plugin={available.plugins.find((p) => p.id === detailId) ?? null}
                    installed={available.installed.includes(detailId) || plugins.some((p) => p.id === detailId)}
                    projectRoot={projectRoot}
                    home={home}
                    configDir={list?.ok ? list.configDir : ""}
                    repoOk={repoOk}
                    cwd={cwd}
                    scope={scope ?? (repoOk ? "local" : "user")}
                    onScope={setScope}
                    busy={busy}
                    confirm={confirm}
                    onBack={() => {
                        setDetailId(null);
                        setConfirm(null);
                    }}
                    onInstall={(op) => void run(op)}
                    onCancelConfirm={() => setConfirm(null)}
                    onShowInstalled={(id) => {
                        setDetailId(null);
                        setView("installed");
                        setHighlight(id);
                    }}
                />
            ) : (
                <BrowseView
                    available={available}
                    installedIds={new Set(plugins.map((p) => p.id))}
                    query={query}
                    onQuery={(q) => {
                        setQuery(q);
                        setShown(PAGE);
                    }}
                    market={market}
                    onMarket={(m) => {
                        setMarket(m);
                        setShown(PAGE);
                    }}
                    sort={sort}
                    onSort={setSort}
                    shown={shown}
                    onMore={() => setShown((n) => n + PAGE * 2)}
                    onOpen={(id) => {
                        setDetailId(id);
                        setConfirm(null);
                    }}
                />
            )}
        </div>
    );
}

// ── 설치됨 ──
function InstalledView(props: {
    list: PluginListResult | null;
    here: PluginGroup[];
    others: InstalledPlugin[];
    details: Record<string, PluginDetailsResult>;
    mcp: McpServer[];
    busy: Busy | null;
    pending: Pending | null;
    repoOk: boolean;
    expanded: Set<string>;
    highlight: string | null;
    othersOpen: boolean;
    onToggleOthers: () => void;
    onExpand: (id: string) => void;
    onPending: (p: Pending | null) => void;
    onRun: (op: PluginOp) => void;
    onBrowse: () => void;
    onLogin: () => void;
}) {
    const {list, here, others} = props;
    if (!list) {
        return (
            <div className={cx("extEmpty")}>
                <FontAwesomeIcon icon={faSpinner} spin /> 설치된 플러그인을 읽는 중…
            </div>
        );
    }
    if (list.ok === false) return <div className={cx("extEmpty", "extEmptyError")}>{list.error}</div>;
    return (
        <>
            {here.length === 0 ? (
                <div className={cx("extEmpty")}>
                    이 폴더에서 쓰는 플러그인이 없습니다.{" "}
                    <button className={cx("extLinkBtn")} onClick={props.onBrowse}>
                        찾아보기
                    </button>
                    에서 설치합니다.
                </div>
            ) : (
                <div className={cx("plugList")}>
                    {here.map((p) => (
                        <InstalledCard key={p.id} plugin={p} {...props} />
                    ))}
                </div>
            )}
            {others.length > 0 && (
                <div className={cx("plugOthers")}>
                    <button className={cx("plugOthersHead")} onClick={props.onToggleOthers} aria-expanded={props.othersOpen}>
                        <FontAwesomeIcon icon={props.othersOpen ? faChevronDown : faChevronRight} />
                        다른 레포에만 설치됨 {others.length}
                    </button>
                    {props.othersOpen && (
                        <ul className={cx("plugOthersList")}>
                            {others.map((p) => (
                                <li
                                    key={`${p.id}:${p.projectPath ?? ""}`}
                                    data-plugin-id={p.id}
                                    className={cx("plugOtherRow", {plugHighlight: props.highlight === p.id})}
                                >
                                    <span className={cx("plugOtherName")}>{p.name}</span>
                                    <span className={cx("extBadge")}>{SCOPE_LABEL[p.scope] ?? p.scope}</span>
                                    <span className={cx("plugOtherPath")} title={p.projectPath}>
                                        <MiddleName name={p.projectPath ?? ""} />
                                    </span>
                                </li>
                            ))}
                            <li className={cx("plugOthersNote")}>그 레포를 작업 폴더로 연 탭에서 켜고 끄거나 지웁니다.</li>
                        </ul>
                    )}
                </div>
            )}
        </>
    );
}

function InstalledCard({
    plugin: p,
    details,
    mcp,
    busy,
    pending,
    repoOk,
    expanded,
    highlight,
    onExpand,
    onPending,
    onRun,
    onLogin,
}: {
    plugin: PluginGroup;
    details: Record<string, PluginDetailsResult>;
    mcp: McpServer[];
    busy: Busy | null;
    pending: Pending | null;
    repoOk: boolean;
    expanded: Set<string>;
    highlight: string | null;
    onExpand: (id: string) => void;
    onPending: (p: Pending | null) => void;
    onRun: (op: PluginOp) => void;
    onLogin: () => void;
}) {
    const d = details[p.id];
    const info = d?.ok ? d.details : null;
    const managed = p.scopes.includes("managed");
    const scopes = p.scopes.filter((s): s is PluginScope => s === "user" || s === "project" || s === "local");
    // 넓은 범위(모든 프로젝트·팀 공유)로 설치된 것은 끌 때 "이 레포에서 나만"도 고를 수 있다
    const broad = scopes.find((s) => s === "user" || s === "project");
    const open = expanded.has(p.id);
    const mine = pending?.id === p.id ? pending : null;
    // MCP 서버: list의 설정(무엇을 실행하는지) + 이 폴더의 MCP 상태(plugin:<플러그인>:<서버>)
    const servers = p.mcpServers.map((s) => ({...s, status: mcp.find((m) => m.name === `plugin:${p.name}:${s.name}`)?.status}));
    const needsLogin = p.enabled ? servers.filter((s) => s.status === "needs-auth") : [];
    const hooks = info?.hooks.filter(Boolean) ?? [];
    const risky = hooks.length > 0 || servers.length > 0 || (info?.mcpServers.length ?? 0) > 0;
    const components = new Map((info?.components ?? []).map((c) => [c.name, c]));

    const toggle = (on: boolean) => {
        if (on) return onRun({kind: "enable", id: p.id});
        // 이 레포에서만 끌 수도 있는 범위면 어디서 끌지 묻는다
        if (broad && repoOk) return onPending({id: p.id, action: "disable"});
        if (scopes[0]) onRun({kind: "disable", id: p.id, scope: scopes[0]});
    };

    return (
        <div data-plugin-id={p.id} className={cx("plugCard", {plugCardOff: !p.enabled, plugHighlight: highlight === p.id})}>
            <div className={cx("plugCardHead")}>
                <FontAwesomeIcon icon={faPuzzlePiece} className={cx("plugCardIcon")} />
                <span className={cx("plugName")}>{p.name}</span>
                {p.version && <span className={cx("plugVersion")}>{p.version}</span>}
                {p.scopes.map((sc) => (
                    <span key={sc} className={cx("extBadge")} title={scopeHelp(sc)}>
                        {SCOPE_LABEL[sc] ?? sc}
                    </span>
                ))}
                {!p.enabled && <span className={cx("extBadge", "extBadgeMuted")}>꺼짐</span>}
                <span className={cx("plugTopSpacer")} />
                <Switch
                    checked={p.enabled}
                    onChange={toggle}
                    label={p.enabled ? `${p.name} 끄기` : `${p.name} 켜기`}
                    disabled={!!busy || managed}
                />
                <button className={cx("extBtn", "extBtnQuiet")} disabled={!!busy || managed} onClick={() => onPending({id: p.id, action: "uninstall"})}>
                    지우기
                </button>
            </div>
            <div className={cx("plugId")}>{p.id}</div>
            {info?.description && <p className={cx("plugDesc")}>{info.description}</p>}
            <div className={cx("plugMeta")}>
                {d === undefined ? (
                    <span className={cx("plugMetaMuted")}>
                        <FontAwesomeIcon icon={faSpinner} spin /> 안에 든 것을 읽는 중…
                    </span>
                ) : info ? (
                    <>
                        <span>
                            스킬 {info.skills.length} · 에이전트 {info.agents.length} · 훅 {info.hooks.length} · MCP {info.mcpServers.length}
                            {info.lspServers.length > 0 ? ` · LSP ${info.lspServers.length}` : ""}
                        </span>
                        {info.alwaysOnTokens !== null && (
                            <span className={cx("plugTokens")} title="CLI가 어림한 값 — 이 플러그인이 켜져 있으면 새 대화마다 처음부터 드는 토큰 (스킬 설명 등)">
                                {info.alwaysOnTokens > 0 ? `대화마다 ${tokens(info.alwaysOnTokens)}` : "대화마다 드는 토큰 없음"}
                            </span>
                        )}
                        <button className={cx("extLinkBtn")} onClick={() => onExpand(p.id)} aria-expanded={open}>
                            {open ? "접기" : "안에 든 것 보기"}
                        </button>
                    </>
                ) : (
                    <span className={cx("plugMetaMuted")}>안에 든 것을 읽지 못했습니다{d.ok === false ? ` — ${d.error}` : ""}</span>
                )}
            </div>
            {risky && (
                <div className={cx("plugRisk")}>
                    <span className={cx("plugRiskBadge")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} /> 내 권한으로 프로그램 실행
                    </span>
                    <span className={cx("plugRiskText")}>
                        {[
                            hooks.length > 0 ? `훅 ${hooks.join(", ")} — 그 순간마다 명령을 실행합니다` : "",
                            ...servers.map((s) => `MCP ${s.name} — ${serverWhat(s)}`),
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                </div>
            )}
            {needsLogin.map((s) => (
                <div key={s.name} className={cx("plugLogin")}>
                    <FontAwesomeIcon icon={faKey} />
                    <span className={cx("plugLoginText")}>{s.name} 서버에 로그인해야 이 플러그인의 도구를 쓸 수 있습니다</span>
                    <button className={cx("extBtn", "extBtnSmall")} onClick={onLogin}>
                        MCP 목록에서 로그인
                    </button>
                </div>
            ))}
            {open && info && (
                <div className={cx("plugInside")}>
                    {info.skills.filter(Boolean).length > 0 && (
                        <div className={cx("plugInsideGroup")}>
                            <div className={cx("plugInsideTitle")}>스킬 {info.skills.length}</div>
                            <ul className={cx("plugInsideList")}>
                                {info.skills.filter(Boolean).map((s) => (
                                    <li key={s}>
                                        <button className={cx("extLinkBtn")} onClick={() => openExtensions("skills", `${p.name}:${s}`)}>
                                            {s}
                                        </button>
                                        {components.get(s) && (
                                            <span className={cx("plugInsideTokens")}>
                                                늘 {components.get(s)?.alwaysOn} · 부를 때 {components.get(s)?.onInvoke}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {info.agents.filter(Boolean).length > 0 && (
                        <div className={cx("plugInsideGroup")}>
                            <div className={cx("plugInsideTitle")}>에이전트 {info.agents.length}</div>
                            <ul className={cx("plugInsideList")}>
                                {info.agents.filter(Boolean).map((a) => (
                                    <li key={a}>
                                        {a}
                                        {components.get(a) && (
                                            <span className={cx("plugInsideTokens")}>
                                                늘 {components.get(a)?.alwaysOn} · 부를 때 {components.get(a)?.onInvoke}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {hooks.length > 0 && (
                        <div className={cx("plugInsideGroup")}>
                            <div className={cx("plugInsideTitle")}>훅 {info.hooks.length}</div>
                            <button className={cx("extLinkBtn")} onClick={() => openExtensions("hooks", p.id)}>
                                {hooks.join(", ")}
                            </button>
                        </div>
                    )}
                    {servers.length > 0 && (
                        <div className={cx("plugInsideGroup")}>
                            <div className={cx("plugInsideTitle")}>MCP 서버 {servers.length}</div>
                            <ul className={cx("plugInsideList")}>
                                {servers.map((s) => (
                                    <li key={s.name}>
                                        {s.name}
                                        <span className={cx("plugInsideTokens")}>
                                            {serverWhat(s)}
                                            {s.status ? ` · ${MCP_STATUS_LABEL[s.status] ?? s.status}` : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {info.lspServers.filter(Boolean).length > 0 && (
                        <div className={cx("plugInsideGroup")}>
                            <div className={cx("plugInsideTitle")}>LSP 서버 {info.lspServers.length}</div>
                            <span>{info.lspServers.filter(Boolean).join(", ")}</span>
                        </div>
                    )}
                    <p className={cx("plugInsideNote")}>
                        토큰은 CLI가 어림한 값입니다. 스킬·에이전트는 설명만 늘 들고, 본문은 부를 때 듭니다. 훅·MCP 도구 설명은 여기 세지 않습니다.
                    </p>
                </div>
            )}
            {mine?.action === "disable" && (
                <div className={cx("plugAsk")} role="group" aria-label="어디서 끌까요">
                    <span className={cx("plugAskText")}>어디서 끌까요?</span>
                    {broad === "project" ? (
                        <button className={cx("extBtn")} onClick={() => onRun({kind: "disable", id: p.id, scope: "project"})}>
                            팀 설정에서 끄기 — 커밋하면 팀원도 꺼집니다
                        </button>
                    ) : (
                        <button className={cx("extBtn")} onClick={() => onRun({kind: "disable", id: p.id, scope: "user"})}>
                            모든 프로젝트에서 끄기
                        </button>
                    )}
                    <button className={cx("extBtn")} onClick={() => onRun({kind: "disable", id: p.id, scope: "local"})}>
                        이 레포에서 나만 끄기
                    </button>
                    <button className={cx("extBtn", "extBtnQuiet")} onClick={() => onPending(null)}>
                        취소
                    </button>
                </div>
            )}
            {mine?.action === "uninstall" && (
                <div className={cx("plugAsk", "plugAskDanger")} role="group" aria-label="지우기 확인">
                    <span className={cx("plugAskText")}>
                        {scopes.length > 1
                            ? `${p.name}은(는) ${scopes.map((sc) => SCOPE_LABEL[sc]).join(", ")} 두 곳에 설치돼 있습니다. 어디서 지울까요?`
                            : `${p.name}을(를) 지울까요? ${UNINSTALL_EFFECT[scopes[0]] ?? ""}`}
                    </span>
                    {scopes.map((sc) => (
                        <button
                            key={sc}
                            className={cx("extBtn", "extBtnDanger")}
                            title={scopes.length > 1 ? UNINSTALL_EFFECT[sc] : undefined}
                            onClick={() => onRun({kind: "uninstall", id: p.id, scope: sc})}
                        >
                            {scopes.length > 1 ? UNINSTALL_WHERE[sc] : "지우기"}
                        </button>
                    ))}
                    <button className={cx("extBtn", "extBtnQuiet")} onClick={() => onPending(null)}>
                        취소
                    </button>
                </div>
            )}
        </div>
    );
}

const UNINSTALL_EFFECT: Record<string, string> = {
    user: "모든 프로젝트에서 사라집니다.",
    project: "팀 공유 설정(.claude/settings.json)에서 빠집니다 — 커밋하면 팀원에게서도 빠집니다.",
    local: "이 레포의 내 설정에서 빠집니다.",
};

const UNINSTALL_WHERE: Record<string, string> = {
    user: "모든 프로젝트에서 지우기",
    project: "팀 설정에서 지우기",
    local: "이 레포 내 설정에서 지우기",
};

function scopeHelp(scope: string): string {
    switch (scope) {
        case "user":
            return "모든 프로젝트에서 켜집니다 (사용자 설정 ~/.claude/settings.json)";
        case "project":
            return "레포의 .claude/settings.json에 적혀 커밋하면 팀원도 설치 안내를 받습니다";
        case "local":
            return "이 레포에서 나에게만 켜집니다 (.claude/settings.local.json — 보통 git에 올라가지 않음)";
        case "managed":
            return "회사 관리 정책으로 설치된 것 — 여기서 바꿀 수 없습니다";
    }
    return scope;
}

// ── 찾아보기 ──
function BrowseView({
    available,
    installedIds,
    query,
    onQuery,
    market,
    onMarket,
    sort,
    onSort,
    shown,
    onMore,
    onOpen,
}: {
    available: PluginAvailableResult | null;
    installedIds: Set<string>;
    query: string;
    onQuery: (q: string) => void;
    market: string;
    onMarket: (m: string) => void;
    sort: "popular" | "name";
    onSort: (s: "popular" | "name") => void;
    shown: number;
    onMore: () => void;
    onOpen: (id: string) => void;
}) {
    const all = useMemo(() => (available?.ok ? available.plugins : []), [available]);
    const markets = useMemo(() => {
        const counts = new Map<string, number>();
        for (const p of all) counts.set(p.marketplace, (counts.get(p.marketplace) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }, [all]);
    const q = query.trim().toLowerCase();
    const hits = useMemo(() => {
        const list = all.filter(
            (p) =>
                (!market || p.marketplace === market) &&
                (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q))
        );
        // 찾는 글이 있으면 이름이 맞는 것 먼저(같음 > 앞부분 > 중간 > 설명에만). 그다음 설치 수(공식 디렉터리 일부에만 있다 —
        // 있는 것 먼저, 많은 순), 그다음 이름순.
        const rank = (p: AvailablePlugin) => {
            const n = p.name.toLowerCase();
            return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) || p.id.toLowerCase().includes(q) ? 2 : 3;
        };
        return list.sort((a, b) => {
            if (q) {
                const d = rank(a) - rank(b);
                if (d !== 0) return d;
            }
            if (sort === "popular") {
                const d = (b.installCount ?? -1) - (a.installCount ?? -1);
                if (d !== 0) return d;
            }
            return a.name.localeCompare(b.name);
        });
    }, [all, market, q, sort]);

    return (
        <>
            <div className={cx("plugToolbar")}>
                <span className={cx("extSearch")}>
                    <FontAwesomeIcon icon={faMagnifyingGlass} className={cx("extSearchIcon")} />
                    <input
                        className={cx("extSearchInput")}
                        value={query}
                        onChange={(e) => onQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (isImeComposing(e)) return;
                            // 글이 있으면 Esc는 글만 지운다 (창은 그대로)
                            if (e.key === "Escape" && query) {
                                e.preventDefault();
                                onQuery("");
                            }
                        }}
                        placeholder="이름·설명으로 찾기"
                        aria-label="플러그인 찾기"
                        autoFocus
                    />
                </span>
                <select className={cx("extSelect")} value={market} onChange={(e) => onMarket(e.target.value)} aria-label="마켓플레이스">
                    <option value="">마켓플레이스 전체</option>
                    {markets.map(([m, n]) => (
                        <option key={m} value={m}>
                            {m} ({n.toLocaleString()})
                        </option>
                    ))}
                </select>
                <select className={cx("extSelect")} value={sort} onChange={(e) => onSort(e.target.value as "popular" | "name")} aria-label="정렬">
                    <option value="popular">설치 많은 순</option>
                    <option value="name">이름순</option>
                </select>
            </div>
            {!available ? (
                <div className={cx("extEmpty")}>
                    <FontAwesomeIcon icon={faSpinner} spin /> 마켓플레이스 목록을 받는 중… (처음엔 몇 초 걸립니다)
                </div>
            ) : available.ok === false ? (
                <div className={cx("extEmpty", "extEmptyError")}>{available.error}</div>
            ) : (
                <>
                    <div className={cx("plugCount")}>
                        {all.length.toLocaleString()}개 중 {hits.length.toLocaleString()}개
                        {sort === "popular" && <span className={cx("plugCountNote")}> · 설치 수는 공식 디렉터리 일부에만 있습니다</span>}
                    </div>
                    {hits.length === 0 ? (
                        <div className={cx("extEmpty")}>"{query.trim()}"에 맞는 플러그인이 없습니다</div>
                    ) : (
                        <ul className={cx("plugBrowseList")}>
                            {hits.slice(0, shown).map((p) => (
                                <li key={p.id}>
                                    <button className={cx("plugRow")} onClick={() => onOpen(p.id)}>
                                        <span className={cx("plugRowHead")}>
                                            <span className={cx("plugName")}>{p.name}</span>
                                            {installedIds.has(p.id) && <span className={cx("extBadge", "extBadgeOk")}>설치됨</span>}
                                            <span className={cx("extBadge", "extBadgeMuted")}>{p.marketplace}</span>
                                            {p.source.kind === "command" && (
                                                <span className={cx("extBadge", "extBadgeWarn")} title="이 컴퓨터에서 명령을 실행해 설치합니다">
                                                    <FontAwesomeIcon icon={faTerminal} /> 명령 실행
                                                </span>
                                            )}
                                            <span className={cx("plugTopSpacer")} />
                                            {p.installCount !== null && <span className={cx("plugInstalls")}>설치 {p.installCount.toLocaleString()}</span>}
                                        </span>
                                        <span className={cx("plugRowDesc")}>{p.description ?? "설명 없음"}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {hits.length > shown && (
                        <button className={cx("extBtn", "plugMore")} onClick={onMore}>
                            {Math.min(hits.length - shown, PAGE * 2).toLocaleString()}개 더 보기 (남은 {(hits.length - shown).toLocaleString()}개)
                        </button>
                    )}
                </>
            )}
        </>
    );
}

// ── 찾아보기의 플러그인 한 개 — 설명·출처·위험 안내, 범위를 골라 설치 ──
const SCOPE_CHOICES: {value: PluginScope; title: string; desc: (root: string, config: string) => string}[] = [
    {value: "local", title: "이 레포에서 나만", desc: (root) => `${root}/.claude/settings.local.json — 보통 git에 올라가지 않습니다. 시험해 볼 때 알맞습니다`},
    {value: "project", title: "팀 공유 — 레포 설정에 기록", desc: (root) => `${root}/.claude/settings.json — 커밋하면 팀원도 이 플러그인을 설치하라는 안내를 받습니다`},
    {value: "user", title: "모든 프로젝트", desc: (_root, config) => `내 사용자 설정(${config}/settings.json) — 어느 폴더에서든 켜집니다`},
];

// 홈 아래 경로는 ~로 줄여 보인다
function tilde(p: string, home: string): string {
    return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
}

function PluginPage({
    plugin,
    installed,
    projectRoot,
    home,
    configDir,
    repoOk,
    cwd,
    scope,
    onScope,
    busy,
    confirm,
    onBack,
    onInstall,
    onCancelConfirm,
    onShowInstalled,
}: {
    plugin: AvailablePlugin | null;
    installed: boolean;
    projectRoot: string;
    home: string;
    configDir: string;
    repoOk: boolean;
    cwd: string;
    scope: PluginScope;
    onScope: (s: PluginScope) => void;
    busy: Busy | null;
    confirm: Confirm | null;
    onBack: () => void;
    onInstall: (op: Extract<PluginOp, {kind: "install"}>) => void;
    onCancelConfirm: () => void;
    onShowInstalled: (id: string) => void;
}) {
    const rootShown = tilde(projectRoot || cwd, home);
    return (
        <div className={cx("plugPage")}>
            <button className={cx("extLinkBtn", "plugBack")} onClick={onBack}>
                <FontAwesomeIcon icon={faArrowLeft} /> 목록으로
            </button>
            {!plugin ? (
                <div className={cx("extEmpty")}>이 플러그인이 목록에서 사라졌습니다 — 새로 고침해 보세요</div>
            ) : (
                <>
                    <div className={cx("plugPageHead")}>
                        <FontAwesomeIcon icon={faPuzzlePiece} className={cx("plugCardIcon")} />
                        <span className={cx("plugPageName")}>{plugin.name}</span>
                        {plugin.version && <span className={cx("plugVersion")}>{plugin.version}</span>}
                        <span className={cx("extBadge", "extBadgeMuted")}>{plugin.marketplace}</span>
                        {plugin.installCount !== null && <span className={cx("plugInstalls")}>설치 {plugin.installCount.toLocaleString()}</span>}
                    </div>
                    <div className={cx("plugId")}>{plugin.id}</div>
                    <p className={cx("plugPageDesc")}>{plugin.description ?? "설명이 없습니다."}</p>
                    <div className={cx("plugSource")}>
                        <span className={cx("plugSourceLabel")}>출처</span>
                        {plugin.source.link ? (
                            <a className={cx("plugSourceLink")} href={plugin.source.link} target="_blank" rel="noreferrer" title={`${plugin.source.link} — 브라우저로 엽니다`}>
                                {plugin.source.text} <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
                            </a>
                        ) : (
                            <span className={cx("plugSourceText")}>{plugin.source.text}</span>
                        )}
                    </div>
                    {plugin.source.command && (
                        <div className={cx("plugCommand")}>
                            <div className={cx("plugCommandTitle")}>
                                <FontAwesomeIcon icon={faTerminal} /> 설치할 때 이 컴퓨터에서 실행하는 명령
                            </div>
                            <code className={cx("plugCommandCode")}>{plugin.source.command}</code>
                        </div>
                    )}
                    <div className={cx("plugWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} className={cx("plugWarnIcon")} />
                        <span>
                            플러그인에 든 <b>훅과 MCP 서버는 이 컴퓨터에서 내 권한으로 프로그램을 실행</b>합니다 — 파일을 읽고 고치거나 네트워크로 보낼 수
                            있습니다. 믿을 수 있는 출처인지 확인하고 설치하세요. 설치한 뒤 &quot;설치됨&quot;에서 무엇이 들었는지(스킬·훅·MCP)와 대화마다 드는
                            토큰을 볼 수 있고, 끄거나 지울 수 있습니다.
                        </span>
                    </div>
                    {installed ? (
                        <div className={cx("plugInstalledNote")}>
                            <FontAwesomeIcon icon={faCheck} /> 이미 설치했습니다.{" "}
                            <button className={cx("extLinkBtn")} onClick={() => onShowInstalled(plugin.id)}>
                                설치됨에서 보기
                            </button>
                        </div>
                    ) : confirm && confirm.op.id === plugin.id ? (
                        <div className={cx("plugConfirm")} role="alertdialog" aria-label="설치 명령 확인">
                            <div className={cx("plugConfirmTitle")}>
                                <FontAwesomeIcon icon={faTriangleExclamation} /> 이 명령을 이 컴퓨터에서 실행해 설치합니다
                            </div>
                            <code className={cx("plugCommandCode")}>{confirm.command}</code>
                            <p className={cx("plugConfirmText")}>
                                마켓플레이스({plugin.marketplace})가 정한 명령이고 내 권한으로 실행됩니다.
                                {confirm.mode === "link" ? " 명령이 알려 준 폴더를 플러그인으로 그대로 씁니다." : ""} 무슨 명령인지 확인한 뒤에만
                                진행하세요.
                            </p>
                            <div className={cx("plugConfirmActions")}>
                                <button
                                    className={cx("extBtn", "extBtnDanger")}
                                    disabled={!!busy}
                                    onClick={() => onInstall({...confirm.op, acceptCommand: confirm.sha256})}
                                >
                                    명령을 실행하고 설치
                                </button>
                                <button className={cx("extBtn", "extBtnQuiet")} onClick={onCancelConfirm}>
                                    취소
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className={cx("plugInstall")}>
                            <div className={cx("plugInstallTitle")}>어디에 설치할까요?</div>
                            <div className={cx("extChoices")} role="radiogroup" aria-label="설치 범위">
                                {SCOPE_CHOICES.map((c) => {
                                    const off = c.value !== "user" && !repoOk;
                                    return (
                                        <button
                                            key={c.value}
                                            role="radio"
                                            aria-checked={scope === c.value}
                                            disabled={off}
                                            className={cx("extChoice", {extChoiceOn: scope === c.value})}
                                            onClick={() => onScope(c.value)}
                                        >
                                            <span className={cx("extRadio")} />
                                            <span className={cx("extChoiceText")}>
                                                <span className={cx("extChoiceTitle")}>{c.title}</span>
                                                <span className={cx("extChoiceDesc")}>
                                                    {off ? "홈 폴더는 레포가 아니라 고를 수 없습니다 — 레포 폴더의 탭에서 여세요" : c.desc(rootShown, tilde(configDir || "~/.claude", home))}
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            <button
                                className={cx("extBtn", "extBtnPrimary")}
                                disabled={!!busy}
                                onClick={() => onInstall({kind: "install", id: plugin.id, scope: scope !== "user" && !repoOk ? "user" : scope})}
                            >
                                {busy?.kind === "install" && busy.id === plugin.id ? "설치 중…" : "설치"}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
