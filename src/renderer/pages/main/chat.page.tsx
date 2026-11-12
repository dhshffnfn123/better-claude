import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import styles from "./chat.page.module.scss";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faBars,
    faBolt,
    faFolder,
    faFolderTree,
    faGears,
    faLayerGroup,
    faPlug,
    faRotateRight,
    faShield,
    faShieldHalved,
    faTrash,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import claudeIcon from "../../assets/better-claude-icon.png";
import type {Attention, ChatCallbacks, ChatNotice} from "../../hooks/useClaudeChat";
import {notifyNeedsInput, notifyTurnDone} from "../../hooks/useNotificationSound";
import {onAnyTab} from "../../tab-events";
import {NotificationSettings} from "./NotificationSettings";
import {ThemeSettings} from "./ThemeSettings";
import {BackgroundTasksPanel} from "./BackgroundTasksPanel";
import {FilesPanel} from "./FilesPanel";
import {FILES_PANEL_MIN_WIDTH, readPref, writePref} from "./files-panel-prefs";
import {ChatTabView, type TabLoadRequest, type TabViewApi} from "./ChatTabView";
import {TabStrip} from "./TabStrip";

const cx = classNames.bind(styles);

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = {low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max"};

interface ModelOption {
    id: string; // 실제 모델 ID (claude-opus-5-5 등) — 별칭이 아니라 이 값으로 저장/전송한다
    label: string;
    description?: string;
    efforts: string[]; // 빈 배열이면 effort 미지원
    fastMode: boolean;
}

// CLI에서 목록을 못 받았을 때 쓰는 내장 목록. 기본값은 main 프로세스(탭의 model)가 정한다.
const FALLBACK_MODELS: ModelOption[] = [
    {id: "claude-opus-5-5", label: "Opus 5.5", efforts: ALL_EFFORTS, fastMode: true},
    {id: "claude-fable-5-1", label: "Fable 5.1", efforts: ALL_EFFORTS, fastMode: false},
    {id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ALL_EFFORTS, fastMode: false},
    {id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ALL_EFFORTS, fastMode: false},
];

// CLI 목록에는 "default"와 "opus"처럼 같은 모델을 가리키는 별칭 행이 섞여 있다.
// 실제 ID 기준으로 중복을 걸러낸다.
function toModelOptions(infos: ClaudeModelInfo[]): ModelOption[] {
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const m of infos) {
        if (m.value === "default") continue;
        const id = m.resolvedModel ?? m.value;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            label: m.displayName,
            description: m.description,
            efforts: m.supportsEffort ? m.supportedEffortLevels ?? ALL_EFFORTS : [],
            fastMode: m.supportsFastMode === true,
        });
    }
    return out;
}

const RATE_LIMIT_LABELS: Record<string, string> = {
    five_hour: "5시간",
    seven_day: "7일",
    seven_day_opus: "7일 Opus",
    seven_day_sonnet: "7일 Sonnet",
    seven_day_overage_included: "7일(추가 포함)",
    overage: "추가 사용량",
};

function formatResetTime(epochSec?: number): string {
    if (!epochSec) return "";
    return new Date(epochSec * 1000).toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

const MCP_STATUS_LABELS: Record<string, string> = {
    connected: "연결됨",
    failed: "실패",
    "needs-auth": "인증 필요",
    pending: "연결 중",
    disabled: "꺼짐",
};

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
}

// ── 탭 ──
const NEW_TAB_TITLE = "새 대화";
const EMPTY_BACKGROUND: BackgroundState = {running: [], finished: []};
const EMPTY_CHANGED: ChangedFilesState = {turn: 0, files: []};

interface TabMeta {
    id: string;
    title: string;
    sessionId: string | null;
    cwd: string;
    model: string; // ""이면 아직 모름 — main이 기본값으로 연 뒤 채운다
    effort: string;
    ultracode: boolean;
    fastMode: boolean;
    skipPermissions: boolean;
    // main에 이 탭의 대화를 열었다. 복원한 탭은 처음 볼 때 연다.
    opened: boolean;
    // 탭 내용이 통째로 바뀔 때마다 오른다 — 여는 도중 바뀌었으면 연 결과를 버리고 다시 연다
    gen: number;
    // 이 탭에서 메시지를 보낸 적이 있다 (빈 새 대화인지)
    sent: boolean;
    isLoading: boolean;
    attention: Attention;
    unseen: boolean;
    background: BackgroundState;
    cost: number | null;
    context: ContextUsage | null;
    changedFiles: ChangedFilesState;
    mcp: McpServer[];
    turnSeq: number;
    load: TabLoadRequest | null;
    resetToken: number;
}

function makeTab(id: string, init: Partial<TabMeta> = {}): TabMeta {
    return {
        id,
        title: NEW_TAB_TITLE,
        sessionId: null,
        cwd: "",
        model: "",
        effort: "",
        ultracode: false,
        fastMode: false,
        skipPermissions: true,
        opened: false,
        gen: 0,
        sent: false,
        isLoading: false,
        attention: null,
        unseen: false,
        background: EMPTY_BACKGROUND,
        cost: null,
        context: null,
        changedFiles: EMPTY_CHANGED,
        mcp: [],
        turnSeq: 0,
        load: null,
        resetToken: 0,
        ...init,
    };
}

function newTabId(): string {
    return crypto.randomUUID();
}

// 알림 제목·탭 표시에 쓰는 작업 폴더 이름 (경로 마지막 부분)
function folderName(cwd: string): string {
    return cwd.split("/").filter(Boolean).pop() ?? "";
}

function titleFromMessage(text: string): string {
    const line = text.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
    if (!line) return NEW_TAB_TITLE;
    return line.length > 40 ? line.slice(0, 39) + "…" : line;
}

// 새 탭은 지금 탭의 작업 폴더와 채팅 설정을 이어받는다
function inheritFrom(base: TabMeta | undefined): Partial<TabMeta> {
    if (!base) return {};
    return {cwd: base.cwd, model: base.model, effort: base.effort, ultracode: base.ultracode, fastMode: base.fastMode};
}

// 대화를 비운 탭 (폴더 변경·대화 삭제) — 화면은 resetToken으로 비운다
function clearedTab(t: TabMeta): Partial<TabMeta> {
    return {
        sessionId: null,
        title: NEW_TAB_TITLE,
        sent: false,
        skipPermissions: true,
        cost: null,
        context: null,
        background: EMPTY_BACKGROUND,
        resetToken: t.resetToken + 1,
    };
}

function shallowSame(t: TabMeta, patch: Partial<TabMeta>): boolean {
    return (Object.keys(patch) as (keyof TabMeta)[]).every((k) => t[k] === patch[k]);
}

const ChatPage = () => {
    const [tabs, setTabs] = useState<TabMeta[]>([]);
    const [activeId, setActiveId] = useState("");
    const [ready, setReady] = useState(false);
    // 지금 탭에 다른 대화를 열 때(빈 새 대화 탭 재사용) 여는 효과를 다시 돌리려고 올린다
    const [openNonce, setOpenNonce] = useState(0);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [mcpOpen, setMcpOpen] = useState(false);
    const [mcpRefreshing, setMcpRefreshing] = useState(false);
    const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
    // 백그라운드 작업 상세 패널: 열려 있으면 패널 위쪽 위치(px), 닫혀 있으면 null
    const [bgPanelTop, setBgPanelTop] = useState<number | null>(null);
    const [rateLimits, setRateLimits] = useState<RateLimitWindow[]>([]);
    const [claudeMissing, setClaudeMissing] = useState(false);
    const [locateError, setLocateError] = useState<string | null>(null);
    const [locating, setLocating] = useState(false);
    // 오른쪽 작업 파일 패널 (기본은 닫힘, 열림·너비는 기억)
    const [filesOpen, setFilesOpen] = useState(() => readPref("filesPanel.open") === "1");
    const [filesWidth, setFilesWidth] = useState(() => {
        const saved = Number(readPref("filesPanel.width"));
        return saved >= FILES_PANEL_MIN_WIDTH ? saved : 380;
    });

    // 콜백·IPC 핸들러에서 최신 값을 읽으려고
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;
    const apiRef = useRef(new Map<string, TabViewApi>());
    const openingRef = useRef(new Set<string>());
    const loadTokenRef = useRef(0);
    const callbacksCache = useRef(new Map<string, ChatCallbacks>());

    const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

    const patchTab = useCallback((id: string, patch: Partial<TabMeta> | ((t: TabMeta) => Partial<TabMeta>)) => {
        setTabs((prev) => {
            const i = prev.findIndex((t) => t.id === id);
            if (i < 0) return prev;
            const p = typeof patch === "function" ? patch(prev[i]) : patch;
            if (shallowSame(prev[i], p)) return prev;
            const next = [...prev];
            next[i] = {...prev[i], ...p};
            return next;
        });
    }, []);

    const registerApi = useCallback((id: string, api: TabViewApi | null) => {
        if (api) apiRef.current.set(id, api);
        else apiRef.current.delete(id);
    }, []);

    // 대화 기록 목록 — 탭 제목도 CLI가 정한 대화 제목으로 맞춘다
    const refreshSessions = useCallback(async () => {
        const list = await window.electronAPI.listSessions();
        setSessions(list);
        const byId = new Map(list.map((s) => [s.sessionId, s]));
        setTabs((prev) => {
            let changed = false;
            const next = prev.map((t) => {
                const s = t.sessionId ? byId.get(t.sessionId) : undefined;
                if (!s?.title || s.title === t.title) return t;
                changed = true;
                return {...t, title: s.title};
            });
            return changed ? next : prev;
        });
    }, []);

    // 탭 화면이 탭 바깥에 알리는 것. 탭마다 한 번 만들어 둔다(탭 화면이 다시 그려지지 않게).
    const callbacksFor = (id: string): ChatCallbacks => {
        let cb = callbacksCache.current.get(id);
        if (cb) return cb;
        const folderTitle = () => folderName(tabsRef.current.find((t) => t.id === id)?.cwd ?? "") || "Better Claude";
        cb = {
            onLoadingChange: (loading) => patchTab(id, {isLoading: loading}),
            onAttention: (kind, summary) => {
                patchTab(id, {attention: kind});
                if (!kind) return;
                const label = kind === "permission" ? "허용을 기다립니다" : "질문이 있습니다";
                notifyNeedsInput(folderTitle(), `${label} — ${summary}`, id !== activeIdRef.current, id);
            },
            onTurnEnd: ({seq, stopped, failed, summary}) => {
                const other = id !== activeIdRef.current;
                patchTab(id, (t) => ({turnSeq: seq, unseen: t.unseen || (other && !stopped)}));
                // 사용자가 직접 중지한 건 완료가 아니므로 알리지 않는다
                if (!stopped) notifyTurnDone(folderTitle(), `${failed ? "오류로 끝났습니다" : "응답 완료"} — ${summary}`, id);
                void refreshSessions();
            },
            onUserMessage: (text) =>
                patchTab(id, (t) => ({sent: true, title: t.title === NEW_TAB_TITLE ? titleFromMessage(text) : t.title})),
        };
        callbacksCache.current.set(id, cb);
        return cb;
    };

    // ── 시작: 저장된 탭 복원 (없으면 새 대화 하나) ──
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const saved = await window.electronAPI.loadTabs();
            if (cancelled) return;
            if (saved.tabs.length === 0) {
                const t = makeTab(newTabId());
                setTabs([t]);
                setActiveId(t.id);
            } else {
                setTabs(
                    saved.tabs.map((s) =>
                        makeTab(s.id, {
                            title: s.title || NEW_TAB_TITLE,
                            sessionId: s.sessionId,
                            cwd: s.cwd,
                            model: s.model,
                            effort: s.effort,
                            ultracode: s.ultracode,
                            fastMode: s.fastMode,
                            sent: !!s.sessionId,
                        })
                    )
                );
                setActiveId(saved.activeId ?? saved.tabs[0].id);
            }
            setReady(true);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // ── 앱 전체·모든 탭에서 오는 것 ──
    useEffect(() => {
        const offs = [
            onAnyTab("background", (id, state) => patchTab(id, {background: state})),
            onAnyTab("cost", (id, {totalCostUsd}) => patchTab(id, {cost: totalCostUsd})),
            onAnyTab("context", (id, usage) => patchTab(id, {context: usage})),
            onAnyTab("changedFiles", (id, state) => patchTab(id, {changedFiles: state})),
            onAnyTab("mcp", (id, list) => patchTab(id, {mcp: list})),
            onAnyTab("session", (id, {sessionId}) => patchTab(id, {sessionId})),
            window.electronAPI.onRateLimits(setRateLimits),
            window.electronAPI.onClaudeNotFound(() => setClaudeMissing(true)),
        ];
        window.electronAPI.listModels().then((infos) => {
            const opts = infos ? toModelOptions(infos) : [];
            if (opts.length > 0) setModels(opts);
        });
        window.electronAPI.getRateLimits().then(setRateLimits);
        window.electronAPI.getClaudeStatus().then((s) => {
            if (!s.found) setClaudeMissing(true);
        });
        void refreshSessions();
        return () => offs.forEach((off) => off());
    }, [patchTab, refreshSessions]);

    // ── 탭을 main에 열기 (새 탭, 복원한 탭을 처음 볼 때, 빈 탭에 다른 대화를 열 때) ──
    const ensureOpened = useCallback(
        async (id: string) => {
            const meta = tabsRef.current.find((t) => t.id === id);
            if (!meta || meta.opened || openingRef.current.has(id)) return;
            openingRef.current.add(id);
            const gen = meta.gen;
            try {
                // 설정을 모르면(첫 탭) main의 기본값을 쓴다
                const settings = meta.model
                    ? {model: meta.model, effort: meta.effort, ultracode: meta.ultracode, fastMode: meta.fastMode}
                    : {};
                const res = await window.electronAPI.openTab(id, {
                    cwd: meta.cwd || undefined,
                    sessionId: meta.sessionId,
                    ...settings,
                });
                let notice: ChatNotice | null = null;
                let messages: LoadedMessage[] | null = null;
                // 복원한 탭의 대화 기록이 사라졌다 — main이 세션을 비웠으니 이 탭은 같은 폴더의 새 대화가 된다
                const missing = !!meta.sessionId && res.sessionMissing;
                if (missing) {
                    messages = [];
                    notice = {
                        level: "warning",
                        message: "이 대화 기록을 찾을 수 없어 새 대화로 시작합니다.",
                        detail: `터미널에서 삭제됐거나, 오래돼 CLI가 정리했을 수 있습니다.\n이전 제목: ${meta.title}`,
                    };
                } else if (meta.sessionId) {
                    // 원래 폴더가 없으면 CLI는 지금 폴더에서 그대로 이어간다 — 모르고 보내지 않게 알린다
                    if (res.cwdMissing) {
                        notice = {
                            level: "warning",
                            message: "이 대화의 원래 작업 폴더가 없습니다. 메시지를 보내면 현재 작업 폴더에서 이어집니다.",
                            detail: `원래 폴더: ${meta.cwd}\n현재 폴더: ${res.cwd}`,
                        };
                    }
                    try {
                        messages = await window.electronAPI.loadSessionMessages(meta.sessionId, meta.cwd || undefined);
                    } catch (e) {
                        messages = [];
                        notice = {level: "error", message: "대화 기록을 불러오지 못했습니다", detail: (e as Error).message};
                    }
                }
                // 여는 사이 탭 내용이 바뀌었으면(다른 대화를 열었으면) 이 결과는 버리고 새로 연다
                if (tabsRef.current.find((t) => t.id === id)?.gen !== gen) return;
                patchTab(id, {
                    opened: true,
                    cwd: res.cwd,
                    model: res.model,
                    effort: res.effort,
                    ultracode: res.ultracode,
                    fastMode: res.fastMode,
                    skipPermissions: res.skipPermissions,
                    ...(missing ? {sessionId: null, title: NEW_TAB_TITLE, sent: false} : {}),
                    ...(messages ? {load: {token: ++loadTokenRef.current, messages, notice}} : {}),
                });
            } finally {
                openingRef.current.delete(id);
                const now = tabsRef.current.find((t) => t.id === id);
                if (now && !now.opened && now.gen !== gen) void ensureOpened(id);
            }
        },
        [patchTab]
    );

    useEffect(() => {
        if (!ready || !activeId) return;
        void ensureOpened(activeId);
        // 본 탭은 "새 응답" 표시를 지운다
        patchTab(activeId, {unseen: false});
    }, [ready, activeId, openNonce, ensureOpened, patchTab]);

    // 탭을 바꾸면 이전 탭의 팝업은 닫는다
    useEffect(() => {
        setBgPanelTop(null);
        setMcpOpen(false);
    }, [activeId]);

    // ── 열린 탭 저장 (앱을 다시 켜면 그대로 연다) ──
    const savedShape = useMemo(
        () =>
            JSON.stringify({
                tabs: tabs.map((t) => ({
                    id: t.id,
                    sessionId: t.sessionId,
                    cwd: t.cwd,
                    title: t.title,
                    model: t.model,
                    effort: t.effort,
                    ultracode: t.ultracode,
                    fastMode: t.fastMode,
                })),
                activeId,
            }),
        [tabs, activeId]
    );
    useEffect(() => {
        if (!ready) return;
        const state = JSON.parse(savedShape) as SavedTabs;
        const timer = window.setTimeout(() => {
            void window.electronAPI.saveTabs(state);
        }, 400);
        return () => window.clearTimeout(timer);
    }, [savedShape, ready]);

    // 사이드바를 열 때마다 다시 읽는다 — 터미널 등 앱 밖에서 생긴 대화도 바로 보이게
    useEffect(() => {
        if (sidebarOpen) void refreshSessions();
    }, [sidebarOpen, refreshSessions]);

    // ── 탭 동작 ──
    const newTab = useCallback(() => {
        const base = tabsRef.current.find((t) => t.id === activeIdRef.current);
        const t = makeTab(newTabId(), inheritFrom(base));
        setTabs((prev) => [...prev, t]);
        setActiveId(t.id);
    }, []);

    const closeTab = useCallback((id: string) => {
        const list = tabsRef.current;
        const t = list.find((x) => x.id === id);
        if (!t) return;
        const running = t.background.running.length;
        if (t.isLoading || running > 0) {
            const state =
                t.isLoading && running > 0
                    ? `응답 중이고 백그라운드 작업 ${running}개도 실행 중입니다`
                    : t.isLoading
                      ? "응답 중입니다"
                      : `백그라운드 작업 ${running}개가 실행 중입니다`;
            if (!window.confirm(`이 탭은 ${state}.\n닫으면 모두 멈춥니다. 탭을 닫을까요?`)) return;
        }
        void window.electronAPI.closeTab(id);
        callbacksCache.current.delete(id);
        const idx = list.findIndex((x) => x.id === id);
        const rest = list.filter((x) => x.id !== id);
        if (rest.length === 0) {
            // 마지막 탭을 닫으면 같은 폴더·설정으로 새 대화 하나를 연다
            const fresh = makeTab(newTabId(), inheritFrom(t));
            setTabs([fresh]);
            setActiveId(fresh.id);
            return;
        }
        setTabs(rest);
        if (activeIdRef.current === id) setActiveId(rest[Math.min(idx, rest.length - 1)].id);
    }, []);

    const selectTabAt = useCallback((n: number) => {
        const list = tabsRef.current;
        const t = n >= 9 ? list[list.length - 1] : list[n - 1];
        if (t) setActiveId(t.id);
    }, []);

    const cycleTab = useCallback((dir: 1 | -1) => {
        const list = tabsRef.current;
        if (list.length < 2) return;
        const i = list.findIndex((t) => t.id === activeIdRef.current);
        setActiveId(list[(i + dir + list.length) % list.length].id);
    }, []);

    // 앱 메뉴의 단축키 (⌘T, ⌘W, ⌃Tab, ⌘1~9)
    useEffect(
        () =>
            window.electronAPI.onMenuTab((action) => {
                if (action === "new") newTab();
                else if (action === "close") closeTab(activeIdRef.current);
                else if (action === "next") cycleTab(1);
                else if (action === "prev") cycleTab(-1);
                else if (action.startsWith("select:")) selectTabAt(Number(action.slice(7)));
            }),
        [newTab, closeTab, cycleTab, selectTabAt]
    );

    // macOS 알림을 누르면 그 알림을 낸 탭으로 (그 사이 닫힌 탭이면 그대로 둔다)
    useEffect(
        () =>
            window.electronAPI.onNotificationClick((tabId) => {
                if (tabsRef.current.some((t) => t.id === tabId)) setActiveId(tabId);
            }),
        []
    );

    // 사이드바에서 지난 대화 열기: 이미 열린 탭이면 그 탭으로, 아니면 새 탭으로 (지금 탭이 빈 새 대화면 그 자리에)
    const openSession = useCallback((session: SessionSummary) => {
        setSidebarOpen(false);
        const list = tabsRef.current;
        const existing = list.find((t) => t.sessionId === session.sessionId);
        if (existing) {
            setActiveId(existing.id);
            return;
        }
        const cur = list.find((t) => t.id === activeIdRef.current);
        const reuse = !!cur && !cur.sessionId && !cur.sent && !cur.isLoading;
        const meta = makeTab(reuse && cur ? cur.id : newTabId(), {
            ...inheritFrom(cur),
            title: session.title || NEW_TAB_TITLE,
            sessionId: session.sessionId,
            cwd: session.cwd,
            sent: true,
            gen: reuse && cur ? cur.gen + 1 : 0,
            resetToken: reuse && cur ? cur.resetToken : 0,
        });
        if (reuse) {
            setTabs((prev) => prev.map((t) => (t.id === meta.id ? meta : t)));
            setOpenNonce((n) => n + 1);
        } else {
            setTabs((prev) => [...prev, meta]);
            setActiveId(meta.id);
        }
    }, []);

    // CLI 세션 기록 자체를 지운다 — 터미널의 /resume 목록에서도 사라진다. 이 대화를 연 탭은 새 대화로 비운다.
    const handleDeleteSession = async (e: React.MouseEvent, session: SessionSummary) => {
        e.stopPropagation();
        const openTabs = tabsRef.current.filter((t) => t.sessionId === session.sessionId);
        const running = openTabs.reduce((n, t) => n + t.background.running.length, 0);
        const message =
            `"${session.title}" 대화 기록을 삭제할까요?\n터미널의 /resume 목록에서도 사라지며 되돌릴 수 없습니다.` +
            (openTabs.length > 0
                ? `\n\n이 대화를 연 탭은 새 대화로 비워집니다${running > 0 ? ` (백그라운드 작업 ${running}개도 종료)` : ""}.`
                : "");
        if (!window.confirm(message)) return;
        await window.electronAPI.deleteSession(session.sessionId, session.cwd);
        for (const t of openTabs) patchTab(t.id, clearedTab);
        await refreshSessions();
    };

    // ── 보고 있는 탭의 설정 ──
    // 설정은 CLI를 띄울 때 고정된다. 다음 메시지를 보낼 때 새 설정으로 다시 띄우면서 작업이 종료된다.
    const warnBackgroundOnSettingChange = () => {
        const n = active?.background.running.length ?? 0;
        if (!active || n === 0) return;
        apiRef.current.get(active.id)?.setNotice({
            level: "warning",
            message: `백그라운드 작업 ${n}개가 실행 중입니다. 바꾼 설정은 다음 메시지부터 적용되며, 그때까지 끝나지 않은 작업은 종료됩니다.`,
        });
    };

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        if (!active) return;
        const next = e.target.value;
        patchTab(active.id, {model: next});
        warnBackgroundOnSettingChange();
        void window.electronAPI.setModel(active.id, next);
    };

    const handleEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        if (!active) return;
        const next = e.target.value;
        patchTab(active.id, {effort: next});
        warnBackgroundOnSettingChange();
        void window.electronAPI.setEffort(active.id, next);
    };

    const handleToggleUltracode = () => {
        if (!active) return;
        const next = !active.ultracode;
        patchTab(active.id, {ultracode: next});
        warnBackgroundOnSettingChange();
        void window.electronAPI.setUltracode(active.id, next);
    };

    const handleToggleFastMode = () => {
        if (!active) return;
        const next = !active.fastMode;
        patchTab(active.id, {fastMode: next});
        warnBackgroundOnSettingChange();
        void window.electronAPI.setFastMode(active.id, next);
    };

    const handleTogglePermissions = async () => {
        if (!active) return;
        const next = !active.skipPermissions;
        patchTab(active.id, {skipPermissions: next});
        warnBackgroundOnSettingChange();
        await window.electronAPI.setPermissions(active.id, next);
        // 전체 허용으로 켜는 순간 대기 중인 요청이 있으면 허용으로 답한다.
        // 그냥 닫아버리면 CLI가 답을 기다리며 멈춘 채로 남는다.
        if (next) apiRef.current.get(active.id)?.respondPermission(true);
    };

    // 탭의 작업 폴더 바꾸기 — 그 탭은 새 대화로 시작한다
    const handleSelectDirectory = async () => {
        if (!active) return;
        const n = active.background.running.length;
        if (n > 0 && !window.confirm(`백그라운드 작업 ${n}개가 실행 중입니다.\n작업 폴더를 바꾸면 이 작업들이 종료됩니다. 계속할까요?`)) {
            return;
        }
        const id = active.id;
        const selected = await window.electronAPI.selectDirectory(id);
        if (!selected) return;
        patchTab(id, (t) => ({...clearedTab(t), cwd: selected, mcp: []}));
    };

    const handleLocateClaude = async () => {
        setLocating(true);
        setLocateError(null);
        const result = await window.electronAPI.locateClaude();
        setLocating(false);
        if (result.ok) {
            setClaudeMissing(false);
        } else {
            const failed = result as {ok: false; cancelled?: boolean; error?: string};
            if (!failed.cancelled) setLocateError(failed.error ?? "경로 지정 실패");
        }
    };

    const toggleBackgroundPanel = (e: React.MouseEvent | React.KeyboardEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setBgPanelTop((cur) => (cur === null ? Math.round(rect.bottom + 6) : null));
    };

    const closeBackgroundPanel = useCallback(() => setBgPanelTop(null), []);

    const bg = active?.background ?? EMPTY_BACKGROUND;
    const backgroundTasks = bg.running;
    // 실행 중인 것도 끝난 기록도 없으면 패널을 닫는다
    const hasBackgroundInfo = bg.running.length > 0 || bg.finished.length > 0;
    useEffect(() => {
        if (!hasBackgroundInfo) setBgPanelTop(null);
    }, [hasBackgroundInfo]);
    const failedCount = bg.finished.filter((f) => f.status === "failed").length;

    const toggleFilesPanel = () => {
        const next = !filesOpen;
        setFilesOpen(next);
        writePref("filesPanel.open", next ? "1" : "0");
    };

    const closeFilesPanel = useCallback(() => {
        setFilesOpen(false);
        writePref("filesPanel.open", "0");
    }, []);

    useEffect(() => {
        writePref("filesPanel.width", String(filesWidth));
    }, [filesWidth]);

    const handleRefreshMcp = async () => {
        if (!active) return;
        const id = active.id;
        setMcpRefreshing(true);
        const list = await window.electronAPI.getMcpStatus(id, true);
        patchTab(id, {mcp: list});
        setMcpRefreshing(false);
    };

    const model = active?.model ?? "";
    const currentModel = models.find((m) => m.id === model);
    // 예전 대화의 구버전 모델처럼 목록에 없으면 effort/fast 지원 여부를 모르니 막지 않는다
    const effortOptions = currentModel ? currentModel.efforts : ALL_EFFORTS;
    const effortSupported = effortOptions.length > 0;
    const fastSupported = currentModel ? currentModel.fastMode : true;
    const ultracode = active?.ultracode ?? false;
    const fastMode = active?.fastMode ?? false;
    const allPermissionsGranted = active?.skipPermissions ?? true;
    const changedFiles = active?.changedFiles ?? EMPTY_CHANGED;
    const mcpServers = active?.mcp ?? [];
    const openSessionIds = new Set(tabs.map((t) => t.sessionId).filter((s): s is string => !!s));

    return (
        <div className={cx("container")}>
            {/* 사이드바 오버레이 */}
            <div className={cx("overlay", {overlayVisible: sidebarOpen})} onClick={() => setSidebarOpen(false)} />

            {/* 사이드바 */}
            <div className={cx("sidebar", {sidebarOpen})}>
                <div className={cx("sidebarHeader")}>메뉴</div>
                <nav className={cx("sidebarNav")}>
                    <div
                        className={cx("navItem")}
                        onClick={() => {
                            newTab();
                            setSidebarOpen(false);
                        }}
                    >
                        새 대화 (새 탭)
                    </div>
                </nav>
                {sessions.length > 0 && (
                    <div className={cx("convListSection")}>
                        <div className={cx("convListLabel")}>대화 기록 (터미널 포함)</div>
                        <div className={cx("convList")}>
                            {sessions.map((session) => (
                                <div
                                    key={session.sessionId}
                                    className={cx("convItem")}
                                    onClick={() => openSession(session)}
                                    title={session.cwd}
                                >
                                    <div className={cx("convTitle")}>{session.title}</div>
                                    <div className={cx("convMeta")}>
                                        {openSessionIds.has(session.sessionId) && (
                                            <span className={cx("convOpen")} title="탭으로 열려 있습니다 — 누르면 그 탭으로 갑니다">
                                                열린 탭
                                            </span>
                                        )}
                                        {session.cwd && (
                                            <span
                                                className={cx("convFolder", {convFolderMissing: session.cwdMissing})}
                                                title={session.cwdMissing ? `작업 폴더가 없습니다: ${session.cwd}` : session.cwd}
                                            >
                                                {session.cwd.split("/").filter(Boolean).pop()}
                                            </span>
                                        )}
                                        {new Date(session.lastModified).toLocaleDateString("ko-KR", {
                                            month: "short",
                                            day: "numeric",
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })}
                                    </div>
                                    <button
                                        className={cx("convDelete")}
                                        onClick={(e) => handleDeleteSession(e, session)}
                                        data-tooltip="삭제"
                                    >
                                        <FontAwesomeIcon icon={faTrash} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* 헤더 */}
            <div className={cx("header")}>
                <button className={cx("menuButton")} data-tooltip="메뉴" data-tooltip-dir="down" onClick={() => setSidebarOpen((v) => !v)}>
                    <FontAwesomeIcon icon={faBars} />
                </button>
                <img src={claudeIcon} className={cx("headerIcon")} alt="Claude" />
                <span className={cx("headerTitle")}>Better Claude</span>
                <span className={cx("headerSpacer")} />
                <NotificationSettings />
                <ThemeSettings />
                <button
                    className={cx("permissionToggle", {active: allPermissionsGranted})}
                    onClick={handleTogglePermissions}
                    data-tooltip={
                        allPermissionsGranted
                            ? "전체 허용 중 · 클릭하면 이 탭의 대화만 확인 모드"
                            : "이 탭의 대화만 확인 모드 · 새 대화는 전체 허용"
                    }
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={allPermissionsGranted ? faShield : faShieldHalved} />
                </button>
                <button
                    className={cx("permissionToggle", "fastToggle", {active: fastMode && fastSupported})}
                    onClick={handleToggleFastMode}
                    disabled={!fastSupported}
                    data-tooltip={
                        !fastSupported
                            ? "Fast 모드는 이 모델에서 지원하지 않습니다"
                            : fastMode
                              ? "Fast 모드 켜짐 — 더 빠른 출력, 2배 가격"
                              : "Fast 모드 켜기 (더 빠른 출력, 2배 가격)"
                    }
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={faBolt} />
                </button>
                <button
                    className={cx("permissionToggle", "ultracodeToggle", {active: ultracode})}
                    onClick={handleToggleUltracode}
                    data-tooltip={
                        ultracode ? "Ultracode 켜짐 — xhigh + 여러 에이전트 동시 실행" : "Ultracode 켜기 (xhigh + 여러 에이전트 동시 실행)"
                    }
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={faLayerGroup} />
                </button>
                <button
                    className={cx("permissionToggle", "filesToggle", {active: filesOpen})}
                    onClick={toggleFilesPanel}
                    data-tooltip={
                        (filesOpen ? "작업 파일 패널 닫기" : "작업 파일 패널 열기") +
                        (changedFiles.files.length > 0 ? ` · 이 대화에서 바뀐 파일 ${changedFiles.files.length}개` : "")
                    }
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={faFolderTree} />
                    {changedFiles.files.length > 0 && <span className={cx("filesToggleBadge")}>{changedFiles.files.length}</span>}
                </button>
            </div>

            {/* 탭 줄 */}
            {active && (
                <TabStrip
                    tabs={tabs.map((t) => ({
                        id: t.id,
                        title: t.title,
                        folder: folderName(t.cwd),
                        cwd: t.cwd,
                        isLoading: t.isLoading,
                        attention: t.attention,
                        unseen: t.unseen,
                        background: t.background.running.length,
                    }))}
                    activeId={active.id}
                    onSelect={setActiveId}
                    onClose={closeTab}
                    onNew={newTab}
                />
            )}

            {/* 보고 있는 탭의 작업 폴더 + 모델 선택 바 */}
            {active && (
                <div className={cx("cwdBar")}>
                    <div className={cx("cwdLeft")} onClick={handleSelectDirectory} title="클릭하여 이 탭의 작업 폴더 변경 (새 대화로 시작)">
                        <FontAwesomeIcon icon={faFolder} className={cx("cwdIcon")} />
                        {/* 앞쪽을 줄이려고 rtl로 그리는데, 그러면 맨 앞 "/"가 끝으로 밀려 보인다(Users/…/app/).
                            앞에 LRM(‎)을 두면 "/"가 왼쪽→오른쪽 글자 사이에 놓여 제자리에 그려진다. */}
                        <span className={cx("cwdPath")}>{active.cwd ? "‎" + active.cwd : "..."}</span>
                    </div>
                    <select className={cx("modelSelect")} value={model} onChange={handleModelChange} onClick={(e) => e.stopPropagation()}>
                        {models.map((m) => (
                            <option key={m.id} value={m.id} title={m.description}>
                                {m.label}
                            </option>
                        ))}
                        {/* 예전 대화를 불러오면 목록에 없는 구버전 모델일 수 있다 — 실제 값을 그대로 보여준다 */}
                        {model && !currentModel && <option value={model}>{model}</option>}
                    </select>
                    <select
                        className={cx("modelSelect")}
                        value={!effortSupported ? "" : ultracode ? "xhigh" : active.effort}
                        onChange={handleEffortChange}
                        onClick={(e) => e.stopPropagation()}
                        disabled={ultracode || !effortSupported}
                        title={
                            !effortSupported
                                ? "이 모델은 effort 설정을 지원하지 않습니다"
                                : ultracode
                                  ? "Ultracode가 켜져 있어 xhigh로 고정됩니다"
                                  : undefined
                        }
                    >
                        {!effortSupported && <option value="">Effort 없음</option>}
                        {effortOptions.map((level) => (
                            <option key={level} value={level}>
                                {EFFORT_LABELS[level] ?? level}
                            </option>
                        ))}
                    </select>
                    {mcpServers.length > 0 && (
                        <span className={cx("mcpWrap")}>
                            <button
                                className={cx("sessionStat", "mcpStat", {
                                    sessionStatWarn: mcpServers.some((m) => m.status === "needs-auth" || m.status === "pending"),
                                    sessionStatDanger: mcpServers.some((m) => m.status === "failed"),
                                })}
                                onClick={() => setMcpOpen((open) => !open)}
                                title="MCP 서버 상태"
                            >
                                <FontAwesomeIcon icon={faPlug} />
                                MCP {mcpServers.filter((m) => m.status === "connected").length}/{mcpServers.length}
                            </button>
                            {mcpOpen && (
                                <>
                                    <div className={cx("mcpBackdrop")} onClick={() => setMcpOpen(false)} />
                                    <div className={cx("mcpPopover")}>
                                        <div className={cx("mcpPopoverHeader")}>
                                            MCP 서버
                                            <button
                                                className={cx("mcpRefresh")}
                                                onClick={handleRefreshMcp}
                                                disabled={mcpRefreshing}
                                                title="다시 확인"
                                            >
                                                <FontAwesomeIcon icon={faRotateRight} spin={mcpRefreshing} />
                                            </button>
                                        </div>
                                        {mcpServers.map((m) => (
                                            <div key={m.name} className={cx("mcpRow")}>
                                                <span className={cx("mcpDot", `mcpDot-${m.status}`)} />
                                                <span className={cx("mcpName")}>{m.name}</span>
                                                <span className={cx("mcpMeta")}>
                                                    {MCP_STATUS_LABELS[m.status] ?? m.status}
                                                    {m.status === "connected" && ` · 도구 ${m.toolCount}`}
                                                    {m.scope && ` · ${m.scope}`}
                                                </span>
                                                {m.error && <span className={cx("mcpError")}>{m.error}</span>}
                                                {/* 앱(SDK)에는 MCP 인증·켜기 기능이 없어 터미널에서 해야 한다 */}
                                                {m.status === "needs-auth" && (
                                                    <span className={cx("mcpHint")}>
                                                        터미널에서 claude를 실행해 /mcp로 인증한 뒤, 위의 ↻로 다시 확인하세요.
                                                    </span>
                                                )}
                                                {m.status === "disabled" && (
                                                    <span className={cx("mcpHint")}>터미널에서 claude를 실행해 /mcp로 켤 수 있습니다.</span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </span>
                    )}
                    {hasBackgroundInfo && (
                        <span
                            className={cx("sessionStat", "backgroundStat", {
                                backgroundStatOpen: bgPanelTop !== null,
                                backgroundStatIdle: backgroundTasks.length === 0,
                                sessionStatDanger: failedCount > 0,
                            })}
                            role="button"
                            tabIndex={0}
                            onClick={toggleBackgroundPanel}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleBackgroundPanel(e);
                                }
                            }}
                            title="눌러서 백그라운드 작업 자세히 보기"
                        >
                            <FontAwesomeIcon icon={faGears} />
                            {backgroundTasks.length > 0 ? `백그라운드 ${backgroundTasks.length}` : `끝난 작업 ${bg.finished.length}`}
                            {failedCount > 0 && ` · 실패 ${failedCount}`}
                            {backgroundTasks.length > 0 && !active.isLoading && (
                                <button
                                    className={cx("backgroundStop")}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        apiRef.current.get(active.id)?.stop();
                                    }}
                                    title="백그라운드 작업 모두 중지"
                                >
                                    <FontAwesomeIcon icon={faXmark} />
                                </button>
                            )}
                        </span>
                    )}
                    {bgPanelTop !== null && hasBackgroundInfo && (
                        <BackgroundTasksPanel
                            tabId={active.id}
                            tasks={backgroundTasks}
                            finished={bg.finished}
                            top={bgPanelTop}
                            canStopAll={!active.isLoading}
                            onStopTask={(id) => void window.electronAPI.stopBackgroundTask(active.id, id)}
                            onStopAll={() => {
                                setBgPanelTop(null);
                                apiRef.current.get(active.id)?.stop();
                            }}
                            onClearFinished={() => void window.electronAPI.clearFinishedBackground(active.id)}
                            onClose={closeBackgroundPanel}
                        />
                    )}
                    {rateLimits
                        .filter((w) => typeof w.utilization === "number")
                        .map((w) => {
                            const pct = Math.round((w.utilization ?? 0) * 100);
                            const label = RATE_LIMIT_LABELS[w.type] ?? w.type;
                            return (
                                <span
                                    key={w.type}
                                    className={cx("sessionStat", {
                                        sessionStatWarn: pct >= 70 || w.status === "allowed_warning",
                                        sessionStatDanger: pct >= 90 || w.status === "rejected",
                                    })}
                                    title={`요금제 사용량 ${label} 한도: ${pct}% 사용 (모든 탭 합계)${
                                        w.resetsAt ? `\n초기화: ${formatResetTime(w.resetsAt)}` : ""
                                    }`}
                                >
                                    {label} {pct}%
                                </span>
                            );
                        })}
                    {active.context && (
                        <span
                            className={cx("sessionStat", {
                                sessionStatWarn: active.context.percentage >= 70,
                                sessionStatDanger: active.context.percentage >= 90,
                            })}
                            title={`컨텍스트 ${active.context.totalTokens.toLocaleString()} / ${active.context.maxTokens.toLocaleString()} 토큰`}
                        >
                            <span className={cx("contextGauge")}>
                                <span
                                    className={cx("contextGaugeFill")}
                                    style={{width: `${Math.min(active.context.percentage, 100)}%`}}
                                />
                            </span>
                            {formatTokens(active.context.totalTokens)}/{formatTokens(active.context.maxTokens)}
                        </span>
                    )}
                    {active.cost !== null && (
                        <span className={cx("sessionStat")} title="이 탭 대화의 누적 예상 비용 (청구 금액이 아닌 추정치)">
                            ${active.cost < 0.01 ? active.cost.toFixed(4) : active.cost.toFixed(2)}
                        </span>
                    )}
                </div>
            )}

            {/* 채팅(탭마다 하나, 보고 있는 탭만 보인다) + 오른쪽 작업 파일 패널 */}
            <div className={cx("mainArea")}>
                <div className={cx("chatColumn")}>
                    {tabs.map((t) => (
                        <ChatTabView
                            key={t.id}
                            tabId={t.id}
                            active={t.id === active?.id}
                            cwd={t.cwd}
                            backgroundRunning={t.background.running.length}
                            load={t.load}
                            resetToken={t.resetToken}
                            callbacks={callbacksFor(t.id)}
                            registerApi={registerApi}
                        />
                    ))}
                </div>
                {filesOpen && active && (
                    <FilesPanel
                        key={active.id}
                        tabId={active.id}
                        cwd={active.cwd}
                        changed={changedFiles}
                        refreshKey={active.turnSeq}
                        width={filesWidth}
                        onResize={setFilesWidth}
                        onClose={closeFilesPanel}
                    />
                )}
            </div>

            {/* Claude CLI 찾기 모달 */}
            {claudeMissing && (
                <>
                    <div className={cx("modalOverlay")} />
                    <div className={cx("modal", "modalWide")}>
                        <div className={cx("modalIcon")}>
                            <FontAwesomeIcon icon={faTriangleExclamation} />
                        </div>
                        <h3 className={cx("modalTitle")}>Claude CLI를 찾을 수 없습니다</h3>
                        <p className={cx("modalDesc")}>
                            앱을 사용하려면 Claude CLI가 필요합니다. 아직 설치하지 않으셨다면 <strong>설치 안내</strong>에서
                            설치 방법을 확인하시거나, 이미 설치했다면 <strong>경로 직접 지정</strong>으로 실행 파일 위치를
                            알려주세요.
                        </p>
                        {locateError && <code className={cx("modalPath")}>{locateError}</code>}
                        <div className={cx("modalActions")}>
                            <button className={cx("modalBtn", "deny")} onClick={() => window.electronAPI.openClaudeInstallGuide()}>
                                설치 안내 열기
                            </button>
                            <button className={cx("modalBtn", "allow")} onClick={handleLocateClaude} disabled={locating}>
                                {locating ? "검증 중..." : "경로 직접 지정"}
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default ChatPage;
