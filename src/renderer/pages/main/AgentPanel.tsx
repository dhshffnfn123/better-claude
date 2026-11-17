import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowLeft, faChevronDown, faChevronRight, faCircleNotch, faRobot, faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {Message, ToolActivity} from "../../hooks/useClaudeChat";
import {ImageViewerContext, TabIdContext} from "../../tab-context";
import {MessageItem, PromptMarkdown} from "./MessageItem";
import {Lightbox} from "./Lightbox";
import {FILES_PANEL_MIN_WIDTH} from "./files-panel-prefs";

const cx = classNames.bind(styles);

// "에이전트가 한 일" — Claude가 일을 맡긴 에이전트(Agent 도구)의 기록 전체: 받은 지시, 쓴 도구와 결과, 최종 보고.
// 작업 파일 패널 자리(오른쪽)에 열린다. 실행 중이면 기록을 2초마다 다시 읽는다(main: agents:get).
// 에이전트가 부른 에이전트는 그 줄을 눌러 들어가고 ←로 돌아온다 (stack은 셸이 가진다).

const POLL_MS = 2000;

const STATUS_TEXT: Record<string, string> = {
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    stopped: "중지됨",
    done: "끝남",
};

const STATUS_CLASS: Record<string, string> = {
    running: "agentStatusRunning",
    completed: "agentStatusOk",
    failed: "agentStatusFailed",
    stopped: "agentStatusStopped",
};

function formatDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}초`;
    return `${Math.floor(s / 60)}분 ${s % 60}초`;
}

// 에이전트가 받은 지시 (첫 번째) / 그 뒤에 더 받은 지시 — 길어서 접어 둔다
function AgentPrompt({text, first}: {text: string; first: boolean}) {
    const [open, setOpen] = useState(false);
    const long = text.length > 280 || text.split("\n").length > 6;
    return (
        <div className={cx("agentPrompt")}>
            <button className={cx("agentPromptToggle")} onClick={() => setOpen((v) => !v)} disabled={!long}>
                {long && <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} />}
                {first ? "받은 지시" : "추가로 받은 지시"}
            </button>
            <div className={cx("agentPromptText", {agentPromptClamped: long && !open})}>
                <PromptMarkdown text={text} />
            </div>
        </div>
    );
}

interface Props {
    tabId: string;
    stack: AgentRef[];
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
    onOpenNested: (ref: AgentRef) => void;
    onBack: () => void;
}

export function AgentPanel({tabId, stack, width, onResize, onClose, onOpenNested, onBack}: Props) {
    const ref = stack[stack.length - 1];
    const refKey = `${ref.toolUseId ?? ""}|${ref.agentId ?? ""}`;
    const [view, setView] = useState<AgentViewResult | null>(null);
    const [lightbox, setLightbox] = useState<string | null>(null);
    const closeLightbox = useCallback(() => setLightbox(null), []);
    const bodyRef = useRef<HTMLDivElement>(null);
    // 실행 중인 에이전트는 바닥을 따라간다 (사용자가 위로 올리면 멈춘다). 끝난 에이전트는 지시부터 읽게 맨 위에서.
    const followRef = useRef(false);
    const placedRef = useRef(false);

    useEffect(() => {
        let alive = true;
        let timer = 0;
        setView(null);
        placedRef.current = false;
        const load = async () => {
            const r: AgentViewResult = await window.electronAPI
                .getAgentView(tabId, ref)
                .catch((e: unknown) => ({ok: false as const, error: String(e)}));
            if (!alive) return;
            setView(r);
            const again = r.ok === true ? r.status === "running" : !!r.pending;
            if (again) timer = window.setTimeout(load, POLL_MS);
        };
        void load();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
        // ref는 refKey가 같으면 같은 대상이다
    }, [tabId, refKey]);

    const messages: Message[] = useMemo(
        () => (view?.ok === true ? view.messages.map((m, i) => ({...m, id: i + 1})) : []),
        [view]
    );
    const running = view?.ok === true && view.status === "running";
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");

    useLayoutEffect(() => {
        const el = bodyRef.current;
        if (!el || messages.length === 0) return;
        if (!placedRef.current) {
            placedRef.current = true;
            followRef.current = running;
            el.scrollTop = running ? el.scrollHeight : 0;
        } else if (followRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [messages, running]);

    const onScroll = () => {
        const el = bodyRef.current;
        if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    // 에이전트가 부른 에이전트로 들어간다
    const openNested = useCallback(
        (tool: ToolActivity) => {
            const input = (tool.input ?? {}) as {subagent_type?: unknown; description?: unknown};
            onOpenNested({
                toolUseId: tool.id,
                agentType: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
                description: typeof input.description === "string" ? input.description : undefined,
            });
        },
        [onOpenNested]
    );

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

    const label = ref.agentType ?? "에이전트";
    return (
        <aside className={cx("filesPanel")} style={{width}}>
            <div className={cx("filesResize")} onPointerDown={startResize} title="끌어서 너비 조절" />
            <div className={cx("filesHeader")}>
                {stack.length > 1 && (
                    <button className={cx("filesHeaderBtn")} onClick={onBack} title="이 에이전트를 부른 에이전트로">
                        <FontAwesomeIcon icon={faArrowLeft} />
                    </button>
                )}
                <span className={cx("filesTitle")}>
                    <FontAwesomeIcon icon={faRobot} className={cx("agentTitleIcon")} /> 에이전트 · {label}
                </span>
                <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            <div className={cx("agentMeta")}>
                {ref.description && <div className={cx("agentDesc")}>{ref.description}</div>}
                {view?.ok === true && (
                    <div className={cx("agentStats")}>
                        <span className={cx("agentStatus", STATUS_CLASS[view.status])}>
                            {running && <FontAwesomeIcon icon={faCircleNotch} spin />} {STATUS_TEXT[view.status] ?? view.status}
                        </span>
                        <span>도구 {view.toolUses}번</span>
                        {view.tokens != null && <span>{view.tokens.toLocaleString()} 토큰</span>}
                        {view.durationMs != null && <span>{formatDuration(view.durationMs)}</span>}
                    </div>
                )}
            </div>
            <div className={cx("agentBody")} ref={bodyRef} onScroll={onScroll}>
                <TabIdContext.Provider value={tabId}>
                    <ImageViewerContext.Provider value={setLightbox}>
                        {!view && <div className={cx("viewerNotice")}>불러오는 중…</div>}
                        {view?.ok === false && <div className={cx("viewerNotice")}>{view.error}</div>}
                        {messages.map((m, i) =>
                            m.role === "user" ? (
                                <AgentPrompt key={m.id} text={m.content} first={i === 0} />
                            ) : (
                                <MessageItem
                                    key={m.id}
                                    msg={m}
                                    isStreaming={false}
                                    senderLabel={label}
                                    markReport={!running && i === lastAssistant}
                                    onImageClick={setLightbox}
                                    onOpenAgent={openNested}
                                />
                            )
                        )}
                        {running && (
                            <div className={cx("viewerNotice")}>
                                <FontAwesomeIcon icon={faCircleNotch} spin /> 일하는 중 — 2초마다 새로 읽습니다
                            </div>
                        )}
                    </ImageViewerContext.Provider>
                </TabIdContext.Provider>
            </div>
            {lightbox && <Lightbox src={lightbox} onClose={closeLightbox} />}
        </aside>
    );
}
