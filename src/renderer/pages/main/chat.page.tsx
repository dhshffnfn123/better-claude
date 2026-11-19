import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import styles from "./chat.page.module.scss";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faBars,
    faBolt,
    faBookOpen,
    faCheck,
    faCircleQuestion,
    faFolder,
    faFolderTree,
    faGear,
    faHourglassHalf,
    faLayerGroup,
    faMagnifyingGlass,
    faPenToSquare,
    faPuzzlePiece,
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
import {AgentPanel} from "./AgentPanel";
import {BackgroundPanel} from "./BackgroundTasksPanel";
import {UserGuide} from "./UserGuide";
import {SettingsDialog} from "./SettingsDialog";
import {UsageMeter} from "./UsageMeter";
import {McpStatus} from "./McpStatus";
import {FilesPanel} from "./FilesPanel";
import {InstructionsPanel} from "./InstructionsPanel";
import {MemoryToasts} from "./MemoryToast";
import {PreviewPanel} from "./HtmlPreview";
import {ExtensionsDialog} from "./extensions/ExtensionsDialog";
import type {ExtensionsHost} from "./extensions/extensions-host";
import {lastExtensionsTab, openExtensions, useExtensionsRequest} from "../../extensions-open";
import type {PreviewRequest} from "../../tab-context";
import {FILES_PANEL_MIN_WIDTH, readPref, writePref} from "./files-panel-prefs";
import {isImeComposing, type PromptHooks} from "./ChatInput";
import {ChatTabView, type TabLoadRequest, type TabViewApi} from "./ChatTabView";
import {TabStrip} from "./TabStrip";
import {type AppCommand, pluginCommandTarget} from "../../slash-commands";
import {ScreenComparePanel} from "./ScreenComparePanel";
import {type CompareRequest, forgetCompareState} from "../../screen-compare";
import {useFigmaFeatures} from "../../figma-setting";

const cx = classNames.bind(styles);

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = {low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max"};

interface ModelOption {
    id: string; // 실제 모델 ID (claude-opus-5-5 등) — 별칭이 아니라 이 값으로 저장/전송한다
    label: string;
    description?: string;
    efforts: string[]; // 빈 배열이면 effort 미지원
    fastMode: boolean;
    aliases?: string[]; // 이 모델을 가리키는 CLI 별칭 (opus, haiku, default …) — 입력창의 /model haiku
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
    const aliases = new Map<string, string[]>();
    for (const m of infos) {
        const id = m.resolvedModel ?? m.value;
        if (m.value !== id) aliases.set(id, [...(aliases.get(id) ?? []), m.value.toLowerCase()]);
    }
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
            aliases: aliases.get(id),
        });
    }
    return out;
}

// 입력창의 "/model <이름>" — CLI와 같은 이름(별칭 opus·haiku…, 모델 ID, 화면 이름)을 받는다. 못 찾으면 null.
function resolveModelArg(arg: string, models: ModelOption[]): string | null {
    const a = arg.trim().toLowerCase();
    const hit = models.find((m) => m.id.toLowerCase() === a || m.aliases?.includes(a) || m.label.toLowerCase() === a);
    if (hit) return hit.id;
    // 별칭을 아직 못 받았을 때(내장 목록) — opus·sonnet·haiku·fable
    const family = /^[a-z]+$/.test(a) ? models.find((m) => m.id.includes(`-${a}-`)) : undefined;
    if (family) return family.id;
    // 목록에 없는 모델 ID(예전 모델 등)는 그대로 — 맞는지는 다음 메시지에서 CLI가 확인한다
    return /^claude-[a-z0-9.-]+$/.test(a) ? a : null;
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
    title: string; // 자동 제목: 첫 메시지 → CLI가 지은 대화 요약
    customTitle: string | null; // 사용자가 붙인 이름 (탭을 더블클릭) — 있으면 자동 제목 대신 보인다
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
    // 대화의 누적 토큰 (CLI의 modelUsage 합 — 헤더의 탭별 사용량)
    usage: TokenTotals | null;
    context: ContextUsage | null;
    changedFiles: ChangedFilesState;
    mcp: McpServer[];
    turnSeq: number;
    load: TabLoadRequest | null;
    resetToken: number;
    // 응답 중에 바꾼 설정 안내 ("다음 메시지부터 적용됩니다") — 그 탭을 볼 때 작업 폴더 줄에 보인다
    settingHint: SettingHint | null;
}

// 응답 중에 모델·effort·fast·ultracode를 바꾸거나 방패를 확인 모드로 바꾸면 그 답변에는 들어가지 않는다 —
// CLI는 띄울 때 받은 설정으로 이번 답변을 끝낸다(main의 optionsKey). 다음 메시지를 보낼 때 새 설정으로 다시 띄운다.
interface SettingHint {
    seq: number; // 바꿀 때마다 오른다 — 같은 안내를 다시 띄우면 애니메이션이 다시 돈다
    settings: boolean; // 모델·effort·fast·ultracode를 바꿨다
    shield: boolean; // 방패를 확인 모드로 바꿨다 (전체 허용으로 되돌리면 바로 적용되므로 거둔다)
    shownAt: number;
}

function settingHintText(h: SettingHint): {text: string; detail: string} {
    if (h.shield && h.settings) {
        return {
            text: "바꾼 설정과 확인 모드는 다음 메시지부터 적용됩니다",
            detail: "지금 답변은 바꾸기 전 설정으로 끝까지 진행되고, 도구도 묻지 않고 계속 실행합니다",
        };
    }
    if (h.shield) return {text: "확인 모드는 다음 메시지부터 적용됩니다", detail: "지금 답변에서는 도구를 묻지 않고 계속 실행합니다"};
    return {text: "다음 메시지부터 적용됩니다", detail: "지금 답변은 바꾸기 전 설정으로 끝까지 진행됩니다"};
}

// 응답이 끝나도 이만큼은 보이게 둔다 (바꾸자마자 응답이 끝나도 읽을 시간)
const SETTING_HINT_MIN_MS = 4000;

function makeTab(id: string, init: Partial<TabMeta> = {}): TabMeta {
    return {
        id,
        title: NEW_TAB_TITLE,
        customTitle: null,
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
        usage: null,
        context: null,
        changedFiles: EMPTY_CHANGED,
        mcp: [],
        turnSeq: 0,
        load: null,
        resetToken: 0,
        settingHint: null,
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
        usage: null,
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
    // 대화 기록: 프로젝트명(작업 폴더 이름)으로 찾기, 여러 개 골라 한 번에 지우기
    const [sessionQuery, setSessionQuery] = useState("");
    const [selecting, setSelecting] = useState(false);
    const [selectedSids, setSelectedSids] = useState<Set<string>>(() => new Set());
    // 사용 가이드 (사이드바 "사용 가이드") — 탭 화면 위에 덮어 연다
    const [guideOpen, setGuideOpen] = useState(false);
    const closeGuide = useCallback(() => setGuideOpen(false), []);
    // 설정 (사이드바 "설정", 사용 가이드 밑) — 사용 가이드처럼 탭 화면 위에 덮어 연다
    const [settingsOpen, setSettingsOpen] = useState(false);
    const closeSettings = useCallback(() => setSettingsOpen(false), []);
    // 확장 창 (사이드바 "확장" 또는 어디서든 openExtensions) — 사용 가이드처럼 탭 화면 위에 덮어 연다
    const [extRequest, closeExtensions] = useExtensionsRequest();
    // 입력창의 /usage·/cost — 헤더의 탭별 사용량을 연다
    const [usageOpenSeq, setUsageOpenSeq] = useState(0);
    // 입력창의 /mcp — 작업 폴더 줄의 MCP 목록을 연다
    const [mcpOpenSeq, setMcpOpenSeq] = useState(0);
    // 입력창의 /model·/effort(인자 없이) — 위 선택 상자를 펼친다
    const modelSelectRef = useRef<HTMLSelectElement>(null);
    const effortSelectRef = useRef<HTMLSelectElement>(null);
    const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
    // 백그라운드 작업 패널 — 작업 파일 패널 자리. 연 탭에서만 보이고, taskId = 보고 있는 작업(null이면 첫 작업)
    const [bgView, setBgView] = useState<{tabId: string; sessionId: string | null; taskId: string | null} | null>(null);
    // "에이전트가 한 일" 패널 — 어느 탭의 어느 대화에서 열었는지와 들어간 순서(에이전트가 부른 에이전트)
    const [agentView, setAgentView] = useState<{tabId: string; sessionId: string | null; stack: AgentRef[]} | null>(null);
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
    // 지침 패널(지침 | 기억) — 작업 파일 패널 자리에 열린다. 작업 폴더 줄의 "지침 N"은 보고 있는 탭의 크기.
    const [instrOpen, setInstrOpen] = useState(false);
    const [instrSummary, setInstrSummary] = useState<{tabId: string; cwd: string; count: number; tokens: number} | null>(null);
    const [instrNonce, setInstrNonce] = useState(0);
    // 기억 알림을 눌렀다 — 그 탭의 지침 패널이 기억 탭에서 이 기억을 연다 (패널이 받으면 지운다)
    const [instrFocus, setInstrFocus] = useState<{tabId: string; path: string} | null>(null);
    // HTML·SVG 미리보기 크게 보기 — 연 탭에서만 보인다(같은 자리: 에이전트 > 백그라운드 > 화면 대조 > 미리보기 > 지침 > 작업 파일)
    const [previewView, setPreviewView] = useState<{tabId: string; req: PreviewRequest} | null>(null);
    // 화면 대조(디자인 ↔ 구현 화면) — 연 탭에서만 보인다. seq: 같은 요청을 다시 보내도 패널이 다시 적용하게
    const [compareView, setCompareView] = useState<{tabId: string; req: CompareRequest; seq: number} | null>(null);
    const compareSeqRef = useRef(0);
    // Figma 기능을 끄면 화면 대조도 닫는다 (들어가는 버튼은 탭 화면이 숨긴다)
    const [figmaOn] = useFigmaFeatures();

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
        // 알림 제목: 폴더 이름 (탭 이름을 붙였으면 "이름 · 폴더" — 어느 탭인지 알게)
        const folderTitle = () => {
            const t = tabsRef.current.find((x) => x.id === id);
            const folder = folderName(t?.cwd ?? "") || "Better Claude";
            return t?.customTitle ? `${t.customTitle} · ${folder}` : folder;
        };
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
            // 새 메시지는 지금 설정으로 나간다 — 남아 있던 "다음 메시지부터" 안내는 거둔다
            onUserMessage: (text) =>
                patchTab(id, (t) => ({
                    sent: true,
                    title: t.title === NEW_TAB_TITLE ? titleFromMessage(text) : t.title,
                    settingHint: null,
                })),
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
                            customTitle: s.customTitle ?? null,
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
            onAnyTab("cost", (id, {totalCostUsd, usage}) => patchTab(id, usage ? {cost: totalCostUsd, usage} : {cost: totalCostUsd})),
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
        // main이 스스로 지운 세션(첫 메시지 재생성 성공 뒤 옛 대화) — 턴 끝의 목록 갱신보다 늦게 지워질 수 있다
        offs.push(window.electronAPI.onSessionsChanged(() => void refreshSessions()));
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

    // ── 열린 탭 저장 (앱을 다시 켜면 그대로 연다) ──
    const savedShape = useMemo(
        () =>
            JSON.stringify({
                tabs: tabs.map((t) => ({
                    id: t.id,
                    sessionId: t.sessionId,
                    cwd: t.cwd,
                    title: t.title,
                    customTitle: t.customTitle,
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

    // 탭 이름 붙이기 (TabStrip에서 탭을 더블클릭) — null이면 자동 제목으로 돌아간다. tabs.json에 같이 저장된다.
    const renameTab = useCallback((id: string, name: string | null) => {
        setTabs((prev) => prev.map((t) => (t.id === id && t.customTitle !== name ? {...t, customTitle: name} : t)));
    }, []);

    // 탭 끌어 옮기기 (TabStrip) — beforeId 앞으로, null이면 맨 끝. 순서는 tabs.json에 그대로 저장된다(⌘숫자도 따라간다).
    const moveTab = useCallback((id: string, beforeId: string | null) => {
        setTabs((prev) => {
            const moving = prev.find((t) => t.id === id);
            if (!moving || id === beforeId) return prev;
            const rest = prev.filter((t) => t.id !== id);
            const at = beforeId ? rest.findIndex((t) => t.id === beforeId) : rest.length;
            if (at < 0) return prev;
            const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
            return next.every((t, i) => t === prev[i]) ? prev : next;
        });
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
        forgetCompareState(id);
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
                else if (action === "find") apiRef.current.get(activeIdRef.current)?.openFind();
                else if (action === "find-next") apiRef.current.get(activeIdRef.current)?.findStep(1);
                else if (action === "find-prev") apiRef.current.get(activeIdRef.current)?.findStep(-1);
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

    // 에이전트 줄·백그라운드 에이전트를 누르면 오른쪽 패널 (작업 파일 패널 자리)
    const openAgent = useCallback((tabId: string, ref: AgentRef) => {
        const sessionId = tabsRef.current.find((t) => t.id === tabId)?.sessionId ?? null;
        setAgentView({tabId, sessionId, stack: [ref]});
        setInstrOpen(false);
        setPreviewView(null);
        setBgView(null);
        setCompareView(null);
    }, []);
    const openPreview = useCallback((tabId: string, req: PreviewRequest) => {
        setPreviewView({tabId, req});
        setAgentView(null);
        setInstrOpen(false);
        setBgView(null);
        setCompareView(null);
    }, []);
    // 입력창 위 작업 줄의 카드·답변 속 실행 줄 → 오른쪽 백그라운드 패널
    const openBackground = useCallback((tabId: string, taskId: string | null) => {
        const sessionId = tabsRef.current.find((t) => t.id === tabId)?.sessionId ?? null;
        setBgView({tabId, sessionId, taskId});
        setAgentView(null);
        setInstrOpen(false);
        setPreviewView(null);
        setCompareView(null);
    }, []);
    // 화면 대조 열기 — 답변 속 Figma 그림의 "구현과 비교", 작업 줄·백그라운드 패널의 [화면 찍기]
    const openCompare = useCallback((tabId: string, req: CompareRequest) => {
        setCompareView({tabId, req, seq: ++compareSeqRef.current});
        setAgentView(null);
        setInstrOpen(false);
        setPreviewView(null);
        setBgView(null);
    }, []);
    const closeCompare = useCallback(() => setCompareView(null), []);
    // 그 탭을 닫거나 Figma 기능을 끄면 닫는다
    useEffect(() => {
        if (compareView && (!figmaOn || !tabs.some((t) => t.id === compareView.tabId))) setCompareView(null);
    }, [tabs, compareView, figmaOn]);
    const closeBackground = useCallback(() => setBgView(null), []);
    const selectBackgroundTask = useCallback((taskId: string) => setBgView((cur) => (cur ? {...cur, taskId} : cur)), []);
    // 그 탭이 없어지거나 다른 대화가 되면 닫는다
    useEffect(() => {
        if (!bgView) return;
        const t = tabs.find((x) => x.id === bgView.tabId);
        if (!t || (bgView.sessionId && t.sessionId !== bgView.sessionId)) setBgView(null);
    }, [tabs, bgView]);
    const closePreview = useCallback(() => setPreviewView(null), []);
    // 그 탭을 닫으면 미리보기도 닫는다
    useEffect(() => {
        if (previewView && !tabs.some((t) => t.id === previewView.tabId)) setPreviewView(null);
    }, [tabs, previewView]);
    const openNestedAgent = useCallback((ref: AgentRef) => {
        setAgentView((cur) => (cur ? {...cur, stack: [...cur.stack, ref]} : cur));
    }, []);
    const agentBack = useCallback(() => {
        setAgentView((cur) => (cur && cur.stack.length > 1 ? {...cur, stack: cur.stack.slice(0, -1)} : cur));
    }, []);
    const closeAgent = useCallback(() => setAgentView(null), []);
    // 그 탭이 다른 대화가 되면(다른 대화 열기·폴더 변경·삭제·탭 닫기) 패널을 닫는다
    useEffect(() => {
        if (!agentView) return;
        const t = tabs.find((x) => x.id === agentView.tabId);
        if (!t || (agentView.sessionId && t.sessionId !== agentView.sessionId)) setAgentView(null);
    }, [tabs, agentView]);

    // "여기까지 새 탭으로": 갈라낸 대화를 그 탭 바로 옆 새 탭으로 열고 그리로 간다. 설정(모델 등)은 갈라낸 탭을 따른다.
    const openFork = useCallback(
        (fromId: string, sessionId: string, title: string, cwd: string) => {
            const from = tabsRef.current.find((t) => t.id === fromId);
            const meta = makeTab(newTabId(), {...inheritFrom(from), title, sessionId, cwd, sent: true});
            setTabs((prev) => {
                const i = prev.findIndex((t) => t.id === fromId);
                return i < 0 ? [...prev, meta] : [...prev.slice(0, i + 1), meta, ...prev.slice(i + 1)];
            });
            setActiveId(meta.id);
            void refreshSessions();
        },
        [refreshSessions]
    );

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

    const visibleSessions = useMemo(() => {
        const q = sessionQuery.trim().toLowerCase();
        return q ? sessions.filter((s) => folderName(s.cwd).toLowerCase().includes(q)) : sessions;
    }, [sessions, sessionQuery]);

    const stopSelecting = () => {
        setSelecting(false);
        setSelectedSids(new Set());
    };

    const toggleSelected = (sid: string) =>
        setSelectedSids((prev) => {
            const next = new Set(prev);
            if (next.has(sid)) next.delete(sid);
            else next.add(sid);
            return next;
        });

    // 지금 보이는(검색된) 대화를 모두 고르거나, 이미 다 골랐으면 모두 푼다
    const allVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((s) => selectedSids.has(s.sessionId));
    const toggleSelectAll = () => setSelectedSids(allVisibleSelected ? new Set() : new Set(visibleSessions.map((s) => s.sessionId)));

    const deleteSelectedSessions = async () => {
        const targets = sessions.filter((s) => selectedSids.has(s.sessionId));
        if (targets.length === 0) return;
        const sids = new Set(targets.map((s) => s.sessionId));
        const openTabs = tabsRef.current.filter((t) => t.sessionId && sids.has(t.sessionId));
        const running = openTabs.reduce((n, t) => n + t.background.running.length, 0);
        const message =
            `대화 기록 ${targets.length}개를 삭제할까요?\n터미널의 /resume 목록에서도 사라지며 되돌릴 수 없습니다.` +
            (openTabs.length > 0
                ? `\n\n이 중 ${openTabs.length}개는 탭으로 열려 있어 그 탭은 새 대화로 비워집니다${
                      running > 0 ? ` (백그라운드 작업 ${running}개도 종료)` : ""
                  }.`
                : "");
        if (!window.confirm(message)) return;
        let failed = 0;
        for (const s of targets) {
            try {
                await window.electronAPI.deleteSession(s.sessionId, s.cwd);
            } catch (e) {
                failed++;
                console.error("[sessions] 삭제 실패", s.sessionId, e);
            }
        }
        for (const t of openTabs) patchTab(t.id, clearedTab);
        stopSelecting();
        await refreshSessions();
        if (failed > 0) window.alert(`${failed}개는 삭제하지 못했습니다.`);
    };

    // 사이드바를 닫으면 고르던 것은 그만둔다 (검색어는 남긴다 — 입력칸에 보인다)
    useEffect(() => {
        if (!sidebarOpen) {
            setSelecting(false);
            setSelectedSids(new Set());
        }
    }, [sidebarOpen]);

    // ── 보고 있는 탭의 설정 ──
    // 설정은 CLI를 띄울 때 고정된다. 다음 메시지를 보낼 때 새 설정으로 다시 띄우면서 작업이 종료된다.

    // 응답 중에 바꿨으면 이번 답변에는 안 들어간다고 알린다 (응답이 없을 때는 어차피 다음 메시지부터라 띄우지 않는다)
    const hintSeqRef = useRef(0);
    const markDeferred = useCallback(
        (id: string, kind: "settings" | "shield") => {
            if (!tabsRef.current.find((t) => t.id === id)?.isLoading) return;
            const seq = ++hintSeqRef.current;
            patchTab(id, (t) => ({
                settingHint: {
                    seq,
                    settings: !!t.settingHint?.settings || kind === "settings",
                    shield: !!t.settingHint?.shield || kind === "shield",
                    shownAt: Date.now(),
                },
            }));
        },
        [patchTab]
    );
    const noteDeferredSetting = (kind: "settings" | "shield") => {
        if (active) markDeferred(active.id, kind);
    };

    // 시스템 프롬프트는 모든 탭에 적용된다(main의 optionsKey에 들어 있다). 그래서 바꾸면 백그라운드 작업이 도는 탭은
    // 다음 메시지 때 CLI를 다시 띄우면서 그 작업이 꺼진다 — 먼저 묻고, 바꾼 뒤에는 탭마다 안내한다.
    const promptHooks = useMemo<PromptHooks>(
        () => ({
            confirm: () => {
                const busy = tabsRef.current.filter((t) => t.background.running.length > 0);
                if (busy.length === 0) return true;
                const n = busy.reduce((sum, t) => sum + t.background.running.length, 0);
                return window.confirm(
                    `백그라운드 작업 ${n}개가 실행 중입니다${busy.length > 1 ? ` (탭 ${busy.length}개)` : ""}.\n` +
                        "시스템 프롬프트는 모든 탭에 적용되어, 그 탭에서 다음 메시지를 보낼 때 작업이 종료됩니다. 계속할까요?"
                );
            },
            changed: () => {
                for (const t of tabsRef.current) {
                    // 응답 중인 탭: 지금 답변은 바꾸기 전 프롬프트로 끝난다
                    markDeferred(t.id, "settings");
                    const n = t.background.running.length;
                    if (n > 0) {
                        apiRef.current.get(t.id)?.setNotice({
                            level: "warning",
                            message: `백그라운드 작업 ${n}개가 실행 중입니다. 바꾼 시스템 프롬프트는 다음 메시지부터 적용되며, 그때까지 끝나지 않은 작업은 종료됩니다.`,
                        });
                    }
                }
            },
        }),
        [markDeferred]
    );

    // 안내는 그 탭의 응답이 끝날 때까지 두고(그동안은 바꾸기 전 설정으로 답하고 있다), 끝나면 최소 시간을 채운 뒤 지운다
    useEffect(() => {
        const timers = tabs
            .filter((t) => t.settingHint && !t.isLoading)
            .map((t) => {
                const hint = t.settingHint as SettingHint;
                const left = Math.max(0, SETTING_HINT_MIN_MS - (Date.now() - hint.shownAt));
                return window.setTimeout(
                    () => patchTab(t.id, (cur) => (cur.settingHint?.seq === hint.seq ? {settingHint: null} : {})),
                    left
                );
            });
        return () => timers.forEach((timer) => window.clearTimeout(timer));
    }, [tabs, patchTab]);

    const warnBackgroundOnSettingChange = () => {
        const n = active?.background.running.length ?? 0;
        if (!active || n === 0) return;
        apiRef.current.get(active.id)?.setNotice({
            level: "warning",
            message: `백그라운드 작업 ${n}개가 실행 중입니다. 바꾼 설정은 다음 메시지부터 적용되며, 그때까지 끝나지 않은 작업은 종료됩니다.`,
        });
    };

    // 보고 있는 탭의 설정 바꾸기 — 위 선택 상자·버튼과 입력창의 /model·/effort·/fast가 같이 쓴다
    const setModelValue = (next: string) => {
        if (!active) return;
        patchTab(active.id, {model: next});
        warnBackgroundOnSettingChange();
        noteDeferredSetting("settings");
        void window.electronAPI.setModel(active.id, next);
    };

    const setEffortValue = (next: string) => {
        if (!active) return;
        patchTab(active.id, {effort: next});
        warnBackgroundOnSettingChange();
        noteDeferredSetting("settings");
        void window.electronAPI.setEffort(active.id, next);
    };

    const setUltracodeValue = (next: boolean) => {
        if (!active) return;
        patchTab(active.id, {ultracode: next});
        warnBackgroundOnSettingChange();
        noteDeferredSetting("settings");
        void window.electronAPI.setUltracode(active.id, next);
    };

    const setFastValue = (next: boolean) => {
        if (!active) return;
        patchTab(active.id, {fastMode: next});
        warnBackgroundOnSettingChange();
        noteDeferredSetting("settings");
        void window.electronAPI.setFastMode(active.id, next);
    };

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => setModelValue(e.target.value);
    const handleEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => setEffortValue(e.target.value);
    const handleToggleUltracode = () => {
        if (active) setUltracodeValue(!active.ultracode);
    };
    const handleToggleFastMode = () => {
        if (active) setFastValue(!active.fastMode);
    };

    const handleTogglePermissions = async () => {
        if (!active) return;
        const next = !active.skipPermissions;
        patchTab(active.id, {skipPermissions: next});
        warnBackgroundOnSettingChange();
        if (!next) {
            // 이번 답변의 CLI는 전체 허용(bypass)으로 떠 있어 일반 도구는 묻지 않고 실행한다
            noteDeferredSetting("shield");
        } else {
            // 전체 허용은 바로 적용된다 — 확인 모드 안내만 거두고, 다른 설정 안내는 남긴다
            const seq = ++hintSeqRef.current;
            patchTab(active.id, (t) =>
                t.settingHint?.shield ? {settingHint: t.settingHint.settings ? {...t.settingHint, shield: false, seq} : null} : {}
            );
        }
        await window.electronAPI.setPermissions(active.id, next);
        // 전체 허용으로 켜는 순간 대기 중인 요청이 있으면 허용으로 답한다.
        // 그냥 닫아버리면 CLI가 답을 기다리며 멈춘 채로 남는다.
        if (next) apiRef.current.get(active.id)?.respondPermission(true);
    };

    // 탭의 작업 폴더 바꾸기 — 그 탭은 새 대화로 시작한다
    const handleSelectDirectory = async () => {
        if (!active) return;
        const n = active.background.running.length;
        // 폴더를 바꾸면 이 탭은 새 대화로 시작한다 — 응답 중이거나 백그라운드 작업이 있으면 그것도 멈추므로 먼저 묻는다
        // (예전에는 백그라운드 작업만 물어서, 응답 중에 바꾸면 묻지도 않고 응답이 끊기고 대화가 비워졌다)
        if (active.isLoading || n > 0) {
            const state =
                active.isLoading && n > 0
                    ? `응답 중이고 백그라운드 작업 ${n}개도 실행 중입니다`
                    : active.isLoading
                      ? "응답 중입니다"
                      : `백그라운드 작업 ${n}개가 실행 중입니다`;
            if (!window.confirm(`${state}.\n작업 폴더를 바꾸면 새 대화로 시작하면서 모두 멈춥니다. 계속할까요?`)) return;
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

    const bg = active?.background ?? EMPTY_BACKGROUND;

    const toggleFilesPanel = () => {
        // 지침·미리보기·백그라운드 패널이 그 자리를 덮고 있으면 걷어서 작업 파일 패널을 보여 준다
        if (
            instrOpen ||
            (previewView && previewView.tabId === active?.id) ||
            (bgView && bgView.tabId === active?.id) ||
            (compareView && compareView.tabId === active?.id)
        ) {
            setInstrOpen(false);
            setPreviewView(null);
            setBgView(null);
            setCompareView(null);
            if (filesOpen) return;
        }
        const next = !filesOpen;
        setFilesOpen(next);
        writePref("filesPanel.open", next ? "1" : "0");
    };

    const toggleInstructions = () => {
        // 미리보기·백그라운드 패널이 그 자리를 덮고 있으면 지침 패널을 보여 준다(닫지 않는다)
        const covered =
            (!!previewView && previewView.tabId === active?.id) ||
            (!!bgView && bgView.tabId === active?.id) ||
            (!!compareView && compareView.tabId === active?.id);
        setInstrOpen((v) => (covered ? true : !v));
        setAgentView(null);
        setPreviewView(null);
        setBgView(null);
        setCompareView(null);
    };
    const closeInstructions = useCallback(() => setInstrOpen(false), []);

    // 기억 알림("클로드는 이것을 기억할 것입니다")을 누르면 → 그 탭의 지침 패널, 기억 탭에서 그 기억 (같은 자리의 다른 패널은 닫는다)
    const openMemoryFromToast = useCallback((tabId: string, memoryPath: string) => {
        if (!tabsRef.current.some((t) => t.id === tabId)) return;
        setActiveId(tabId);
        setInstrOpen(true);
        setAgentView(null);
        setPreviewView(null);
        setBgView(null);
        setCompareView(null);
        setInstrFocus({tabId, path: memoryPath});
    }, []);
    const clearInstrFocus = useCallback(() => setInstrFocus(null), []);

    // 작업 폴더 줄의 "지침 N" — main이 이 탭을 연 뒤에 묻는다(그 전에는 main이 홈 폴더 기준이다).
    // 응답이 끝날 때마다·지침 파일이 바뀔 때마다 다시 묻는다(main이 캐시하므로 보통 CLI를 띄우지 않는다).
    const instrTabId = active?.opened ? active.id : null;
    const instrCwd = active?.cwd ?? "";
    const instrModel = active?.model ?? "";
    const instrTurn = active?.turnSeq ?? 0;
    useEffect(() => {
        if (!instrTabId) return;
        let alive = true;
        window.electronAPI
            .getInstructionsSummary(instrTabId)
            .then((s) => {
                if (alive) setInstrSummary(s ? {tabId: instrTabId, cwd: instrCwd, ...s} : null);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [instrTabId, instrCwd, instrModel, instrTurn, instrNonce]);
    useEffect(() => onAnyTab("instructions", () => setInstrNonce((n) => n + 1)), []);
    const instrShown = instrSummary && active && instrSummary.tabId === active.id && instrSummary.cwd === active.cwd ? instrSummary : null;

    const closeFilesPanel = useCallback(() => {
        setFilesOpen(false);
        writePref("filesPanel.open", "0");
    }, []);

    useEffect(() => {
        writePref("filesPanel.width", String(filesWidth));
    }, [filesWidth]);

    // MCP 팝업의 ↻·다시 연결 결과 — 누른 탭의 목록으로 (그사이 탭을 바꿨어도)
    const patchMcp = useCallback((id: string, list: McpServer[]) => patchTab(id, {mcp: list}), [patchTab]);

    // 확장 창 안에서 창 바깥을 여는 길 — MCP 목록(로그인), 지침 패널. 창을 닫고 보고 있는 탭에서 연다.
    const extensionsHost = useMemo<ExtensionsHost>(
        () => ({
            close: closeExtensions,
            openMcp: () => {
                closeExtensions();
                setMcpOpenSeq((n) => n + 1);
            },
            openInstructions: () => {
                closeExtensions();
                setInstrOpen(true);
                setAgentView(null);
                setPreviewView(null);
                setBgView(null);
                setCompareView(null);
            },
        }),
        [closeExtensions]
    );

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

    // ── 입력창의 슬래시 명령 중 앱이 하는 것 (slash-commands.ts) ──
    // CLI(SDK)에서 /model·/effort는 "this session only"(= 이번 프로세스)라 메시지마다 CLI를 새로 띄우는 앱에서는 다음
    // 메시지에 사라졌고, /fast는 SDK에서 안 되며("not available in the Agent SDK"), /clear는 CLI 쪽만 새 대화가 되고 앱은
    // 옛 대화를 이어 썼다(모두 실측). 그래서 앱의 같은 기능 — 위 선택 상자·버튼, 새 대화, 패널 — 으로 하고 그 탭에 알린다.
    const startNewConversation = async (t: TabMeta) => {
        const n = t.background.running.length;
        if (t.isLoading || n > 0) {
            const state =
                t.isLoading && n > 0
                    ? `응답 중이고 백그라운드 작업 ${n}개도 실행 중입니다`
                    : t.isLoading
                      ? "응답 중입니다"
                      : `백그라운드 작업 ${n}개가 실행 중입니다`;
            if (!window.confirm(`${state}.\n새 대화로 시작하면 모두 멈춥니다. 계속할까요?`)) return;
            // 응답부터 닫는다 — 응답 뒤에 보내려던 메시지는 입력창으로 돌아간다
            if (t.isLoading) apiRef.current.get(t.id)?.stop();
        }
        // main이 이 탭의 대화를 비운다(CLI 정리·세션 없음) — 폴더·설정은 그대로. 지금 대화는 사이드바에 남는다.
        await window.electronAPI.openTab(t.id, {
            cwd: t.cwd || undefined,
            sessionId: null,
            model: t.model,
            effort: t.effort,
            ultracode: t.ultracode,
            fastMode: t.fastMode,
        });
        patchTab(t.id, (cur) => clearedTab(cur));
    };
    // 인자 없는 /model·/effort — 터미널처럼 고르는 목록을 펼친다 (못 펼치면 false → 알림으로 안내)
    const openPicker = (el: HTMLSelectElement | null): boolean => {
        const picker = el as (HTMLSelectElement & {showPicker?: () => void}) | null;
        if (!picker || picker.disabled || !picker.showPicker) return false;
        try {
            picker.showPicker();
            return true;
        } catch {
            return false;
        }
    };
    const appCommandRef = useRef<(tabId: string, cmd: AppCommand) => void>(() => undefined);
    appCommandRef.current = (tabId, cmd) => {
        const t = tabsRef.current.find((x) => x.id === tabId);
        // 입력창은 보고 있는 탭에만 있다 — 그 사이 다른 탭으로 옮겼으면 하지 않는다
        if (!t || !active || t.id !== active.id) return;
        const say = (message: string, level: ChatNotice["level"] = "info") => apiRef.current.get(tabId)?.setNotice({level, message});
        const arg = cmd.args.trim().toLowerCase();
        const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id;
        const modelNames = models.map((m) => m.aliases?.find((a) => a !== "default") ?? m.id).join(", ");
        const later = " — 다음 메시지부터 적용됩니다";
        switch (cmd.action) {
            case "new-conversation":
                void startNewConversation(t);
                return;
            case "model": {
                if (!arg) {
                    if (!openPicker(modelSelectRef.current)) say(`지금 모델: ${modelLabel(t.model)} — /model 뒤에 이름(${modelNames})을 붙이거나 위 모델 선택에서 고르세요`);
                    return;
                }
                const id = resolveModelArg(arg, models);
                if (!id) {
                    say(`"${cmd.args.trim()}" 모델을 찾지 못했습니다 — 쓸 수 있는 이름: ${modelNames}, 또는 모델 ID`, "warning");
                    return;
                }
                if (id !== t.model) setModelValue(id);
                say(`이 탭의 모델: ${modelLabel(id)}${id !== t.model ? later : ""}`);
                return;
            }
            case "effort": {
                const [level, onOff] = arg.split(/\s+/);
                if (!arg) {
                    if (!openPicker(effortSelectRef.current)) say(`지금 effort: ${ultracode ? "XHigh (Ultracode)" : EFFORT_LABELS[t.effort] ?? t.effort} — /effort ${effortOptions.join("|")}`);
                    return;
                }
                if (level === "ultracode") {
                    const on = onOff !== "off";
                    if (on !== t.ultracode) setUltracodeValue(on);
                    say(on ? `Ultracode 켬 — xhigh 고정, 여러 에이전트 동시 실행${on !== t.ultracode ? later : ""}` : `Ultracode 끔${on !== t.ultracode ? later : ""}`);
                    return;
                }
                if (!effortSupported) {
                    say("이 모델은 effort 설정을 지원하지 않습니다", "warning");
                    return;
                }
                if (!effortOptions.includes(level) || onOff) {
                    say(`쓸 수 있는 effort: ${effortOptions.join(", ")}, ultracode on|off${level === "auto" ? " — auto는 앱에 없습니다" : ""}`, "warning");
                    return;
                }
                if (level !== t.effort) setEffortValue(level);
                say(
                    `이 탭의 effort: ${EFFORT_LABELS[level] ?? level}` +
                        (ultracode ? " — Ultracode가 켜져 있는 동안은 XHigh로 고정됩니다" : level !== t.effort ? later : "")
                );
                return;
            }
            case "fast": {
                if (!fastSupported) {
                    say("Fast 모드는 이 모델에서 지원하지 않습니다", "warning");
                    return;
                }
                const next = arg === "on" ? true : arg === "off" ? false : arg ? null : !t.fastMode;
                if (next === null) {
                    say("/fast, /fast on, /fast off 중 하나로 쓰세요", "warning");
                    return;
                }
                if (next !== t.fastMode) setFastValue(next);
                say(next ? `Fast 모드 켬 — 더 빠른 출력, 2배 가격${next !== t.fastMode ? later : ""}` : `Fast 모드 끔${next !== t.fastMode ? later : ""}`);
                return;
            }
            case "settings":
                setSettingsOpen(true);
                return;
            case "guide":
                setGuideOpen(true);
                return;
            case "mcp":
                if (t.mcp.length > 0) setMcpOpenSeq((n) => n + 1);
                else say("이 폴더에는 MCP 서버가 없습니다 — 터미널에서 claude mcp add로 추가하면 작업 폴더 줄에 MCP가 보입니다");
                return;
            case "usage":
                setUsageOpenSeq((n) => n + 1);
                return;
            case "instructions":
                setInstrOpen(true);
                setAgentView(null);
                setPreviewView(null);
                setBgView(null);
                setCompareView(null);
                return;
            case "background":
                openBackground(tabId, null);
                return;
            case "sessions":
                setSidebarOpen(true);
                return;
            case "plugins": {
                // /plugin, /plugin install <이름> … → 확장 창의 플러그인 탭 (그 플러그인을 찾아서)
                const target = pluginCommandTarget(cmd.args);
                if (target.kind === "notice") apiRef.current.get(tabId)?.setNotice(target.notice);
                else openExtensions("plugins", target.focus);
                return;
            }
        }
    };
    const handleAppCommand = useCallback((tabId: string, cmd: AppCommand) => appCommandRef.current(tabId, cmd), []);

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
                        <FontAwesomeIcon icon={faPenToSquare} className={cx("navIcon")} />
                        새 대화 (새 탭)
                    </div>
                    <div
                        className={cx("navItem")}
                        onClick={() => {
                            setGuideOpen(true);
                            setSidebarOpen(false);
                        }}
                    >
                        <FontAwesomeIcon icon={faCircleQuestion} className={cx("navIcon")} />
                        사용 가이드
                    </div>
                    <div
                        className={cx("navItem")}
                        onClick={() => {
                            openExtensions(lastExtensionsTab());
                            setSidebarOpen(false);
                        }}
                    >
                        <FontAwesomeIcon icon={faPuzzlePiece} className={cx("navIcon")} />
                        확장
                    </div>
                    <div
                        className={cx("navItem")}
                        onClick={() => {
                            setSettingsOpen(true);
                            setSidebarOpen(false);
                        }}
                    >
                        <FontAwesomeIcon icon={faGear} className={cx("navIcon")} />
                        설정
                    </div>
                </nav>
                {sessions.length > 0 && (
                    <div className={cx("convListSection")}>
                        <div className={cx("convListHead")}>
                            {selecting ? (
                                <>
                                    <span className={cx("convListLabel", "convListLabelSelecting")}>{selectedSids.size}개 선택</span>
                                    <button className={cx("convHeadBtn")} onClick={toggleSelectAll} disabled={visibleSessions.length === 0}>
                                        {allVisibleSelected ? "모두 풀기" : "모두 선택"}
                                    </button>
                                    <button
                                        className={cx("convHeadBtn", "convHeadBtnDanger")}
                                        onClick={() => void deleteSelectedSessions()}
                                        disabled={selectedSids.size === 0}
                                    >
                                        삭제
                                    </button>
                                    <button className={cx("convHeadBtn")} onClick={stopSelecting}>
                                        취소
                                    </button>
                                </>
                            ) : (
                                <>
                                    <span className={cx("convListLabel")}>대화 기록 (터미널 포함)</span>
                                    <button className={cx("convHeadBtn")} onClick={() => setSelecting(true)} title="여러 개 골라 한 번에 삭제">
                                        선택
                                    </button>
                                </>
                            )}
                        </div>
                        <div className={cx("convSearch")}>
                            <FontAwesomeIcon icon={faMagnifyingGlass} className={cx("convSearchIcon")} />
                            <input
                                className={cx("convSearchInput")}
                                value={sessionQuery}
                                onChange={(e) => setSessionQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (isImeComposing(e)) return;
                                    if (e.key === "Escape") setSessionQuery("");
                                }}
                                placeholder="프로젝트명으로 찾기"
                                aria-label="프로젝트명으로 대화 찾기"
                            />
                            {sessionQuery && (
                                <button className={cx("convSearchClear")} onClick={() => setSessionQuery("")} aria-label="검색어 지우기">
                                    <FontAwesomeIcon icon={faXmark} />
                                </button>
                            )}
                        </div>
                        <div className={cx("convList")}>
                            {visibleSessions.length === 0 && (
                                <div className={cx("convEmpty")}>‘{sessionQuery.trim()}’ 프로젝트의 대화가 없습니다</div>
                            )}
                            {visibleSessions.map((session) => (
                                <div
                                    key={session.sessionId}
                                    className={cx("convItem", {
                                        convItemSelecting: selecting,
                                        convItemSelected: selecting && selectedSids.has(session.sessionId),
                                    })}
                                    onClick={() => (selecting ? toggleSelected(session.sessionId) : openSession(session))}
                                    title={session.cwd}
                                >
                                    {selecting && (
                                        <span className={cx("convCheck")} aria-hidden>
                                            {selectedSids.has(session.sessionId) && <FontAwesomeIcon icon={faCheck} />}
                                        </span>
                                    )}
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
                                    {!selecting && (
                                        <button
                                            className={cx("convDelete")}
                                            onClick={(e) => handleDeleteSession(e, session)}
                                            data-tooltip="삭제"
                                        >
                                            <FontAwesomeIcon icon={faTrash} />
                                        </button>
                                    )}
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
                <UsageMeter
                    tabs={tabs.map((t) => ({
                        id: t.id,
                        title: t.customTitle ?? t.title,
                        folder: folderName(t.cwd),
                        sessionId: t.sessionId,
                        usage: t.usage,
                        cost: t.cost,
                    }))}
                    activeId={active?.id ?? ""}
                    onSelect={setActiveId}
                    openSignal={usageOpenSeq}
                />
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
                        title: t.customTitle ?? t.title,
                        autoTitle: t.title,
                        named: t.customTitle != null,
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
                    onMove={moveTab}
                    onRename={renameTab}
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
                        {/* 이 대화에 들어가는 지침(CLAUDE.md 등)의 크기 — 누르면 지침 패널. title=""은 폴더 바꾸기 안내가 겹쳐 뜨지 않게 */}
                        {active.opened && (
                            <button
                                className={cx("instrChip", {instrChipActive: instrOpen})}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    toggleInstructions();
                                }}
                                title=""
                                data-tooltip={
                                    instrShown
                                        ? instrShown.count > 0
                                            ? `Claude가 대화마다 읽는 지침 ${instrShown.count}개 · ${instrShown.tokens.toLocaleString()} 토큰 — 눌러서 보기·고치기`
                                            : "이 폴더에서 읽는 지침 파일이 없습니다 — 눌러서 만들기"
                                        : "지침과 기억 보기"
                                }
                                data-tooltip-dir="down"
                            >
                                <FontAwesomeIcon icon={faBookOpen} />
                                {instrShown ? (instrShown.count > 0 ? `지침 ${formatTokens(instrShown.tokens)}` : "지침 없음") : "지침"}
                            </button>
                        )}
                    </div>
                    {active.settingHint && (
                        <span
                            key={active.settingHint.seq}
                            className={cx("settingHint")}
                            role="status"
                            data-tooltip={settingHintText(active.settingHint).detail}
                            data-tooltip-dir="down"
                        >
                            <FontAwesomeIcon icon={faHourglassHalf} className={cx("settingHintIcon")} />
                            <span className={cx("settingHintText")}>{settingHintText(active.settingHint).text}</span>
                        </span>
                    )}
                    <select
                        ref={modelSelectRef}
                        className={cx("modelSelect")}
                        value={model}
                        onChange={handleModelChange}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {models.map((m) => (
                            <option key={m.id} value={m.id} title={m.description}>
                                {m.label}
                            </option>
                        ))}
                        {/* 예전 대화를 불러오면 목록에 없는 구버전 모델일 수 있다 — 실제 값을 그대로 보여준다 */}
                        {model && !currentModel && <option value={model}>{model}</option>}
                    </select>
                    <select
                        ref={effortSelectRef}
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
                    <McpStatus tabId={active.id} servers={mcpServers} onList={patchMcp} openSignal={mcpOpenSeq} />
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
                                    }${w.receivedAt ? `\n${formatResetTime(w.receivedAt / 1000)}에 받은 값 — 다음 응답 때 갱신됩니다` : ""}`}
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
                            background={t.background}
                            bgPanelOpen={bgView?.tabId === t.id}
                            bgPanelTaskId={bgView?.tabId === t.id ? bgView.taskId : null}
                            onOpenBackground={openBackground}
                            onCloseBackground={closeBackground}
                            load={t.load}
                            resetToken={t.resetToken}
                            callbacks={callbacksFor(t.id)}
                            registerApi={registerApi}
                            promptHooks={promptHooks}
                            onFork={openFork}
                            onOpenAgent={openAgent}
                            onOpenPreview={openPreview}
                            onAppCommand={handleAppCommand}
                            onOpenCompare={openCompare}
                        />
                    ))}
                </div>
                {active && agentView?.tabId === active.id ? (
                    <AgentPanel
                        tabId={active.id}
                        stack={agentView.stack}
                        width={filesWidth}
                        onResize={setFilesWidth}
                        onClose={closeAgent}
                        onOpenNested={openNestedAgent}
                        onBack={agentBack}
                    />
                ) : active && bgView?.tabId === active.id ? (
                    <BackgroundPanel
                        tabId={active.id}
                        state={bg}
                        selectedId={bgView.taskId}
                        onSelect={selectBackgroundTask}
                        canStopAll={!active.isLoading}
                        onStopTask={(id) => void window.electronAPI.stopBackgroundTask(active.id, id)}
                        onStopAll={() => void window.electronAPI.stopAllBackground(active.id)}
                        onClearFinished={() => void window.electronAPI.clearFinishedBackground(active.id)}
                        onOpenAgent={(ref) => openAgent(active.id, ref)}
                        onCaptureScreen={figmaOn ? (url) => openCompare(active.id, {url, capture: true}) : undefined}
                        width={filesWidth}
                        onResize={setFilesWidth}
                        onClose={closeBackground}
                    />
                ) : active && compareView?.tabId === active.id ? (
                    <ScreenComparePanel
                        key={active.id}
                        tabId={active.id}
                        req={compareView.req}
                        reqSeq={compareView.seq}
                        background={bg}
                        listImages={() => apiRef.current.get(active.id)?.listImages() ?? []}
                        onFill={(text, images) => apiRef.current.get(active.id)?.fillInput(text, images) ?? false}
                        width={filesWidth}
                        onResize={setFilesWidth}
                        onClose={closeCompare}
                    />
                ) : active && previewView?.tabId === active.id ? (
                    <PreviewPanel
                        key={`${active.id}:${previewView.req.title}:${previewView.req.file ?? ""}:${(previewView.req.html ?? previewView.req.svg ?? "").length}`}
                        tabId={active.id}
                        req={previewView.req}
                        width={filesWidth}
                        onResize={setFilesWidth}
                        onClose={closePreview}
                    />
                ) : instrOpen && active ? (
                    <InstructionsPanel
                        key={active.id}
                        tabId={active.id}
                        cwd={active.cwd}
                        opened={active.opened}
                        refreshKey={active.turnSeq}
                        width={filesWidth}
                        onResize={setFilesWidth}
                        onClose={closeInstructions}
                        focusMemory={instrFocus?.tabId === active.id ? instrFocus : null}
                        onFocusDone={clearInstrFocus}
                    />
                ) : filesOpen && active && (
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

            {/* 기억 알림 — Claude가 기억을 저장하면 창 가운데에 잠깐 (보고 있는 탭의 것만, 다른 탭 것은 그 탭으로 갈 때) */}
            <MemoryToasts activeTabId={active?.id ?? null} tabIds={tabs.map((t) => t.id)} onOpen={openMemoryFromToast} />

            {guideOpen && <UserGuide onClose={closeGuide} />}
            {settingsOpen && <SettingsDialog onClose={closeSettings} />}
            {extRequest && active && <ExtensionsDialog tabId={active.id} cwd={active.cwd} request={extRequest} host={extensionsHost} />}

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
