import {useCallback, useEffect, useRef, useState} from "react";
import styles from "./chat.page.module.scss";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown,
    faBars,
    faBolt,
    faClockRotateLeft,
    faCircleExclamation,
    faFolder,
    faGears,
    faLayerGroup,
    faPlug,
    faRotateRight,
    faShield,
    faShieldHalved,
    faTrash,
    faTriangleExclamation,
    faVolumeHigh,
    faVolumeXmark,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import claudeIcon from "../../assets/better-claude-icon.png";
import type {ImagePayload} from "../../hooks/useClaudeChat";
import {useClaudeChat} from "../../hooks/useClaudeChat";
import {useNotificationSound} from "../../hooks/useNotificationSound";
import {MessageItem} from "./MessageItem";
import {ChatInput} from "./ChatInput";
import {ActivityPanel, middleTruncate} from "./ActivityPanel";
import {QuestionModal} from "./QuestionModal";

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

// CLI에서 목록을 못 받았을 때 쓰는 내장 목록. 기본값은 main 프로세스(currentModel)가 정한다.
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

interface RewindState {
    uuid: string;
    loading: boolean;
    preview: RewindFilesResult | null;
    done: RewindFilesResult | null;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
}

const ChatPage = () => {
    const {
        messages,
        isLoading,
        isThinking,
        permissionRequest,
        questionRequest,
        thinkingText,
        tools,
        elapsedMs,
        runningTokens,
        notice,
        setNotice,
        send,
        regenerate,
        editAndResend,
        respondPermission,
        answerQuestions,
        stopGeneration,
        newConversation,
        loadSession,
    } = useClaudeChat();
    const {soundEnabled, toggleSound} = useNotificationSound();

    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
    const [mcpOpen, setMcpOpen] = useState(false);
    const [mcpRefreshing, setMcpRefreshing] = useState(false);
    const [allPermissionsGranted, setAllPermissionsGranted] = useState(true);
    const [cwd, setCwd] = useState("");
    const [model, setModel] = useState("");
    const [effort, setEffort] = useState("");
    const [ultracode, setUltracode] = useState(false);
    const [fastMode, setFastMode] = useState(false);
    const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
    const [costUsd, setCostUsd] = useState<number | null>(null);
    const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
    const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
    const [rateLimits, setRateLimits] = useState<RateLimitWindow[]>([]);
    const [rewind, setRewind] = useState<RewindState | null>(null);
    const [showScrollBottom, setShowScrollBottom] = useState(false);
    const [claudeMissing, setClaudeMissing] = useState(false);
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const [locateError, setLocateError] = useState<string | null>(null);
    const [locating, setLocating] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const messageListRef = useRef<HTMLDivElement>(null);
    const isAtBottomRef = useRef(true);

    useEffect(() => {
        if (isAtBottomRef.current) {
            const el = messageListRef.current;
            if (el) el.scrollTop = el.scrollHeight;
        }
    }, [messages]);

    useEffect(() => {
        window.electronAPI.getCwd().then(setCwd);
        window.electronAPI.getModel().then(setModel);
        window.electronAPI.getEffort().then(setEffort);
        window.electronAPI.getUltracode().then(setUltracode);
        window.electronAPI.getFastMode().then(setFastMode);
        window.electronAPI.listModels().then((infos) => {
            const opts = infos ? toModelOptions(infos) : [];
            if (opts.length > 0) setModels(opts);
        });
        window.electronAPI.listSessions().then(setSessions);
        window.electronAPI.getMcpStatus().then(setMcpServers);
        const removeMcp = window.electronAPI.onMcpStatus(setMcpServers);
        window.electronAPI.getClaudeStatus().then((s) => {
            if (!s.found) setClaudeMissing(true);
        });
        const removeNotFound = window.electronAPI.onClaudeNotFound(() => setClaudeMissing(true));
        const removeCost = window.electronAPI.onCost(({totalCostUsd}) => setCostUsd(totalCostUsd));
        const removeContext = window.electronAPI.onContextUsage(setContextUsage);
        const removeBackground = window.electronAPI.onBackgroundTasks(setBackgroundTasks);
        window.electronAPI.getRateLimits().then(setRateLimits);
        const removeRateLimits = window.electronAPI.onRateLimits(setRateLimits);
        return () => {
            removeMcp();
            removeRateLimits();
            removeBackground();
            removeNotFound();
            removeCost();
            removeContext();
        };
    }, []);

    useEffect(() => {
        if (!lightboxSrc) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setLightboxSrc(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [lightboxSrc]);

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

    // 응답이 끝나면 세션 목록을 다시 읽는다(제목·순서는 CLI가 관리)
    const wasLoadingRef = useRef(false);
    useEffect(() => {
        if (wasLoadingRef.current && !isLoading) {
            window.electronAPI.listSessions().then(setSessions);
        }
        wasLoadingRef.current = isLoading;
    }, [isLoading]);

    // 비용/컨텍스트는 세션 단위 지표라 세션이 바뀌면 비운다
    const startNewConversation = useCallback(async () => {
        setCostUsd(null);
        setContextUsage(null);
        await newConversation();
    }, [newConversation]);

    // 저장된 세션 열기. 모델은 바꾸지 않는다 — 지금 고른 모델로 이어서 대화한다.
    const handleLoadSession = async (session: SessionSummary) => {
        setCostUsd(null);
        setContextUsage(null);
        setSidebarOpen(false);
        try {
            const loaded = await window.electronAPI.loadSessionMessages(session.sessionId, session.cwd);
            const resumedCwd = await window.electronAPI.resumeSession(session.sessionId, session.cwd);
            loadSession(loaded);
            setCwd(resumedCwd);
        } catch (e) {
            setNotice({level: "error", message: "대화 기록을 불러오지 못했습니다", detail: (e as Error).message});
        }
    };

    // CLI 세션 기록 자체를 지운다 — 터미널의 /resume 목록에서도 사라진다
    const handleDeleteSession = async (e: React.MouseEvent, session: SessionSummary) => {
        e.stopPropagation();
        if (!window.confirm(`"${session.title}" 대화 기록을 삭제할까요?\n터미널의 /resume 목록에서도 사라지며 되돌릴 수 없습니다.`)) return;
        const current = await window.electronAPI.getSessionId();
        await window.electronAPI.deleteSession(session.sessionId, session.cwd);
        if (current === session.sessionId) await startNewConversation();
        setSessions(await window.electronAPI.listSessions());
    };

    const handleToggleMcp = () => {
        setMcpOpen((open) => !open);
    };

    const handleRefreshMcp = async () => {
        setMcpRefreshing(true);
        setMcpServers(await window.electronAPI.getMcpStatus(true));
        setMcpRefreshing(false);
    };

    const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        const next = e.target.value;
        setModel(next);
        await window.electronAPI.setModel(next);
    };

    const handleEffortChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        const next = e.target.value;
        setEffort(next);
        await window.electronAPI.setEffort(next);
    };

    const handleToggleUltracode = async () => {
        const next = !ultracode;
        setUltracode(next);
        await window.electronAPI.setUltracode(next);
    };

    const handleToggleFastMode = async () => {
        const next = !fastMode;
        setFastMode(next);
        await window.electronAPI.setFastMode(next);
    };

    const handleSelectDirectory = async () => {
        const selected = await window.electronAPI.selectDirectory();
        if (selected) {
            setCwd(selected);
            await startNewConversation();
        }
    };

    const handleMessageScroll = () => {
        const el = messageListRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // 바닥 근처면 다시 따라가고, 충분히 위로 올라가면 따라가기 해제.
        // 자동 스크롤은 항상 바닥(거리≈0)에 닿으므로 이 판정이 자동 스크롤을 오해하지 않는다.
        if (distanceFromBottom < 20) isAtBottomRef.current = true;
        else if (distanceFromBottom > 80) isAtBottomRef.current = false;
        setShowScrollBottom(distanceFromBottom > 80);
    };

    // 위로 스크롤(휠/트랙패드)하면 즉시 따라가기 해제 — 읽는 도중 끌려 내려가지 않게
    const handleMessageWheel = (e: React.WheelEvent) => {
        if (e.deltaY < 0) isAtBottomRef.current = false;
    };

    const scrollToBottom = () => {
        const el = messageListRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        isAtBottomRef.current = true;
        setShowScrollBottom(false);
    };

    const handleTogglePermissions = async () => {
        const next = !allPermissionsGranted;
        setAllPermissionsGranted(next);
        await window.electronAPI.setPermissions(next);
        // 전체 허용으로 켜는 순간 대기 중인 요청이 있으면 허용으로 답한다.
        // 그냥 닫아버리면 CLI가 답을 기다리며 멈춘 채로 남는다.
        if (next) respondPermission(true);
    };

    // 먼저 미리보기(dryRun)로 무엇이 바뀌는지 보여주고, 확인을 받은 뒤 되돌린다
    const handleRewindFiles = useCallback(async (uuid: string) => {
        setRewind({uuid, loading: true, preview: null, done: null});
        const preview = await window.electronAPI.rewindFiles(uuid, true);
        setRewind((cur) => (cur?.uuid === uuid ? {...cur, loading: false, preview} : cur));
    }, []);

    const confirmRewind = async () => {
        if (!rewind) return;
        const uuid = rewind.uuid;
        setRewind({...rewind, loading: true});
        const done = await window.electronAPI.rewindFiles(uuid, false);
        setRewind((cur) => (cur?.uuid === uuid ? {...cur, loading: false, done} : cur));
    };

    const handleSend = useCallback(
        (text: string, images: ImagePayload[]) => {
            send(text, images);
            isAtBottomRef.current = true;
        },
        [send]
    );

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");

    const currentModel = models.find((m) => m.id === model);
    // 예전 대화의 구버전 모델처럼 목록에 없으면 effort/fast 지원 여부를 모르니 막지 않는다
    const effortOptions = currentModel ? currentModel.efforts : ALL_EFFORTS;
    const effortSupported = effortOptions.length > 0;
    const fastSupported = currentModel ? currentModel.fastMode : true;

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
                            startNewConversation();
                            setSidebarOpen(false);
                        }}
                    >
                        새 대화
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
                                    onClick={() => handleLoadSession(session)}
                                    title={session.cwd}
                                >
                                    <div className={cx("convTitle")}>{session.title}</div>
                                    <div className={cx("convMeta")}>
                                        {session.cwd && (
                                            <span className={cx("convFolder")}>
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
                Better Claude
                <button
                    className={cx("permissionToggle")}
                    style={{marginLeft: "auto"}}
                    onClick={startNewConversation}
                    data-tooltip="새 대화"
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={faRotateRight} />
                </button>
                <button
                    className={cx("permissionToggle", {active: soundEnabled})}
                    onClick={toggleSound}
                    data-tooltip={soundEnabled ? "알림음 켜짐 (클릭해서 끄기)" : "알림음 꺼짐 (클릭해서 켜기)"}
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={soundEnabled ? faVolumeHigh : faVolumeXmark} />
                </button>
                <button
                    className={cx("permissionToggle", {active: allPermissionsGranted})}
                    onClick={handleTogglePermissions}
                    data-tooltip={allPermissionsGranted ? "권한 허용 중 (클릭해서 해제)" : "전체 권한 허용"}
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
                        ultracode
                            ? "Ultracode 켜짐 — xhigh + 여러 에이전트 동시 실행"
                            : "Ultracode 켜기 (xhigh + 여러 에이전트 동시 실행)"
                    }
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={faLayerGroup} />
                </button>
            </div>

            {/* 작업 디렉토리 + 모델 선택 바 */}
            <div className={cx("cwdBar")}>
                <div className={cx("cwdLeft")} onClick={handleSelectDirectory} title="클릭하여 작업 디렉토리 변경">
                    <FontAwesomeIcon icon={faFolder} className={cx("cwdIcon")} />
                    <span className={cx("cwdPath")}>{cwd || "..."}</span>
                </div>
                <select
                    className={cx("modelSelect")}
                    value={model}
                    onChange={handleModelChange}
                    onClick={(e) => e.stopPropagation()}
                >
                    {models.map((m) => (
                        <option key={m.id} value={m.id} title={m.description}>{m.label}</option>
                    ))}
                    {/* 예전 대화를 불러오면 목록에 없는 구버전 모델일 수 있다 — 실제 값을 그대로 보여준다 */}
                    {model && !currentModel && <option value={model}>{model}</option>}
                </select>
                <select
                    className={cx("modelSelect")}
                    value={!effortSupported ? "" : ultracode ? "xhigh" : effort}
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
                        <option key={level} value={level}>{EFFORT_LABELS[level] ?? level}</option>
                    ))}
                </select>
                {mcpServers.length > 0 && (
                    <span className={cx("mcpWrap")}>
                        <button
                            className={cx("sessionStat", "mcpStat", {
                                sessionStatWarn: mcpServers.some((m) => m.status === "needs-auth" || m.status === "pending"),
                                sessionStatDanger: mcpServers.some((m) => m.status === "failed"),
                            })}
                            onClick={handleToggleMcp}
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
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </span>
                )}
                {backgroundTasks.length > 0 && (
                    <span
                        className={cx("sessionStat", "backgroundStat")}
                        title={`실행 중인 백그라운드 작업\n${backgroundTasks.map((t) => `· ${t.description}`).join("\n")}\n\n끝나면 Claude가 이어서 응답합니다`}
                    >
                        <FontAwesomeIcon icon={faGears} />
                        백그라운드 {backgroundTasks.length}
                        {!isLoading && (
                            <button
                                className={cx("backgroundStop")}
                                onClick={stopGeneration}
                                title="백그라운드 작업 모두 중지"
                            >
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        )}
                    </span>
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
                                title={`요금제 사용량 ${label} 한도: ${pct}% 사용${
                                    w.resetsAt ? `\n초기화: ${formatResetTime(w.resetsAt)}` : ""
                                }`}
                            >
                                {label} {pct}%
                            </span>
                        );
                    })}
                {contextUsage && (
                    <span
                        className={cx("sessionStat", {
                            sessionStatWarn: contextUsage.percentage >= 70,
                            sessionStatDanger: contextUsage.percentage >= 90,
                        })}
                        title={`컨텍스트 ${contextUsage.totalTokens.toLocaleString()} / ${contextUsage.maxTokens.toLocaleString()} 토큰`}
                    >
                        <span className={cx("contextGauge")}>
                            <span
                                className={cx("contextGaugeFill")}
                                style={{width: `${Math.min(contextUsage.percentage, 100)}%`}}
                            />
                        </span>
                        {formatTokens(contextUsage.totalTokens)}/{formatTokens(contextUsage.maxTokens)}
                    </span>
                )}
                {costUsd !== null && (
                    <span className={cx("sessionStat")} title="이 세션의 누적 예상 비용 (청구 금액이 아닌 추정치)">
                        ${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}
                    </span>
                )}
            </div>

            {/* 채팅 영역 */}
            <div className={cx("messageListWrap")}>
                <div
                    className={cx("messageList")}
                    ref={messageListRef}
                    onScroll={handleMessageScroll}
                    onWheel={handleMessageWheel}
                >
                    {messages.map((msg, i) => (
                        <MessageItem
                            key={msg.id}
                            msg={msg}
                            isStreaming={isThinking && i === messages.length - 1}
                            onImageClick={setLightboxSrc}
                            onRegenerate={
                                !isLoading &&
                                i === messages.length - 1 &&
                                msg.role === "assistant" &&
                                lastUserIdx >= 0
                                    ? regenerate
                                    : undefined
                            }
                            onEditResend={!isLoading && i === lastUserIdx ? editAndResend : undefined}
                            onRewindFiles={!isLoading ? handleRewindFiles : undefined}
                        />
                    ))}
                    {notice && (
                        <div className={cx("notice", notice.level === "error" ? "noticeError" : "noticeWarning")}>
                            <FontAwesomeIcon
                                icon={notice.level === "error" ? faCircleExclamation : faTriangleExclamation}
                                className={cx("noticeIcon")}
                            />
                            <div className={cx("noticeBody")}>
                                <div className={cx("noticeMessage")}>{notice.message}</div>
                                {notice.detail && notice.detail !== notice.message && (
                                    <details className={cx("noticeDetails")}>
                                        <summary className={cx("noticeSummary")}>자세히</summary>
                                        <pre className={cx("noticeDetail")}>{notice.detail}</pre>
                                    </details>
                                )}
                            </div>
                            <button
                                className={cx("noticeClose")}
                                onClick={() => setNotice(null)}
                                aria-label="닫기"
                            >
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>
                    )}
                    <div ref={bottomRef} />
                </div>
                <button
                    className={cx("scrollBottomButton", {visible: showScrollBottom})}
                    onClick={scrollToBottom}
                    data-tooltip="맨 아래로"
                    aria-label="맨 아래로"
                >
                    <FontAwesomeIcon icon={faArrowDown} />
                </button>
            </div>

            {/* 활동 패널 */}
            {isLoading && (
                <ActivityPanel
                    isThinking={isThinking}
                    tools={tools}
                    thinkingText={thinkingText}
                    elapsedMs={elapsedMs}
                    runningTokens={runningTokens}
                />
            )}

            {/* 입력 영역 */}
            <ChatInput isLoading={isLoading} onSend={handleSend} onStop={stopGeneration} />

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
                            앱을 사용하려면 Claude CLI가 필요합니다. 아직 설치하지 않으셨다면{" "}
                            <strong>설치 안내</strong>에서 설치 방법을 확인하시거나, 이미 설치했다면{" "}
                            <strong>경로 직접 지정</strong>으로 실행 파일 위치를 알려주세요.
                        </p>
                        {locateError && (
                            <code className={cx("modalPath")}>{locateError}</code>
                        )}
                        <div className={cx("modalActions")}>
                            <button
                                className={cx("modalBtn", "deny")}
                                onClick={() => window.electronAPI.openClaudeInstallGuide()}
                            >
                                설치 안내 열기
                            </button>
                            <button
                                className={cx("modalBtn", "allow")}
                                onClick={handleLocateClaude}
                                disabled={locating}
                            >
                                {locating ? "검증 중..." : "경로 직접 지정"}
                            </button>
                        </div>
                    </div>
                </>
            )}

            {/* 이미지 라이트박스 */}
            {lightboxSrc && (
                <div className={cx("lightboxOverlay")} onClick={() => setLightboxSrc(null)}>
                    <button
                        className={cx("lightboxClose")}
                        onClick={() => setLightboxSrc(null)}
                        aria-label="닫기"
                    >
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                    <img
                        src={lightboxSrc}
                        className={cx("lightboxImage")}
                        alt=""
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            )}

            {/* Claude의 선택지 질문 (AskUserQuestion) */}
            {questionRequest && (
                <QuestionModal
                    questions={questionRequest.questions}
                    onAnswer={answerQuestions}
                    onSkip={() => answerQuestions(questionRequest.questions.map(() => []))}
                />
            )}

            {/* 파일 되돌리기 확인 */}
            {rewind && (
                <>
                    <div className={cx("modalOverlay")} onClick={() => !rewind.loading && setRewind(null)} />
                    <div className={cx("modal", "modalWide")}>
                        <div className={cx("modalIcon")}>
                            <FontAwesomeIcon icon={faClockRotateLeft} />
                        </div>
                        <h3 className={cx("modalTitle")}>
                            {rewind.done ? "파일 되돌리기 결과" : "이 메시지 이전으로 파일 되돌리기"}
                        </h3>
                        {rewind.loading && <p className={cx("modalDesc")}>확인하는 중…</p>}
                        {!rewind.loading && rewind.done && (
                            <p className={cx("modalDesc")}>
                                {rewind.done.canRewind
                                    ? `파일 ${rewind.preview?.filesChanged?.length ?? 0}개를 되돌렸습니다. 대화 내용은 그대로입니다.`
                                    : `되돌리지 못했습니다: ${rewind.done.error ?? "알 수 없는 오류"}`}
                            </p>
                        )}
                        {!rewind.loading && !rewind.done && rewind.preview && (
                            rewind.preview.canRewind && (rewind.preview.filesChanged?.length ?? 0) > 0 ? (
                                <>
                                    <p className={cx("modalDesc")}>
                                        아래 파일이 이 메시지를 보내기 직전 상태로 돌아갑니다
                                        {` (+${rewind.preview.insertions ?? 0} −${rewind.preview.deletions ?? 0})`}.
                                        대화 내용은 바뀌지 않습니다.
                                    </p>
                                    <div className={cx("rewindFileList")}>
                                        {rewind.preview.filesChanged?.map((f) => {
                                            const rel = cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f;
                                            return (
                                                <code key={f} className={cx("rewindFile")} title={f}>
                                                    {middleTruncate(rel, 70)}
                                                </code>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : (
                                <p className={cx("modalDesc")}>
                                    {rewind.preview.canRewind
                                        ? "이 메시지 이후 Claude가 바꾼 파일이 없습니다."
                                        : `되돌릴 수 없습니다: ${rewind.preview.error ?? "알 수 없는 오류"}`}
                                </p>
                            )
                        )}
                        <div className={cx("modalActions")}>
                            <button
                                className={cx("modalBtn", "deny")}
                                onClick={() => setRewind(null)}
                                disabled={rewind.loading}
                            >
                                {rewind.done || !rewind.preview?.filesChanged?.length ? "닫기" : "취소"}
                            </button>
                            {!rewind.done && rewind.preview?.canRewind && (rewind.preview.filesChanged?.length ?? 0) > 0 && (
                                <button
                                    className={cx("modalBtn", "allow")}
                                    onClick={confirmRewind}
                                    disabled={rewind.loading}
                                >
                                    되돌리기
                                </button>
                            )}
                        </div>
                    </div>
                </>
            )}

            {/* 권한 요청 팝업 */}
            {permissionRequest && (
                <>
                    {/* 바깥을 눌러도 거부로 답한다 — 답을 안 보내면 CLI가 계속 멈춰 있다 */}
                    <div className={cx("modalOverlay")} onClick={() => respondPermission(false)} />
                    <div className={cx("modal", "modalWide")}>
                        <div className={cx("modalIcon")}>
                            <FontAwesomeIcon icon={faShield} />
                        </div>
                        <h3 className={cx("modalTitle")}>
                            {permissionRequest.title ??
                                `${permissionRequest.displayName ?? permissionRequest.toolName} 실행을 허용할까요?`}
                        </h3>
                        {permissionRequest.decisionReason && (
                            <p className={cx("modalDesc")}>{permissionRequest.decisionReason}</p>
                        )}
                        {permissionRequest.target && (
                            <code className={cx("modalPath")}>{permissionRequest.target}</code>
                        )}
                        <div className={cx("modalActions")}>
                            <button
                                className={cx("modalBtn", "deny")}
                                onClick={() => respondPermission(false)}
                            >
                                거부
                            </button>
                            <button
                                className={cx("modalBtn", "allow")}
                                onClick={() => respondPermission(true)}
                            >
                                허용
                            </button>
                        </div>
                        {permissionRequest.alwaysAllow && permissionRequest.alwaysAllow.length > 0 && (
                            <button
                                className={cx("modalAlwaysBtn")}
                                onClick={() => respondPermission(true, true)}
                                title={permissionRequest.alwaysAllow.join("\n")}
                            >
                                이 대화에서 항상 허용
                                <span className={cx("modalAlwaysRule")}>
                                    {middleTruncate(permissionRequest.alwaysAllow.join(", "), 80)}
                                </span>
                            </button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default ChatPage;
