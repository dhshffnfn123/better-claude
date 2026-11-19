import {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowDown, faCheck, faCircleNotch, faCopy, faGears, faStop, faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {middleTruncate} from "./ActivityPanel";
import {copyText} from "../../clipboard";
import {
    type AnyTask,
    allTasks,
    finishedLabel,
    formatElapsed,
    kindOf,
    runningOnly,
    statusInfo,
    terminatedNote,
    taskName,
    taskTokens,
    TOKENS_HINT,
    useNow,
} from "./background-tasks";
import {compactTokens} from "../../token-format";
import {startPanelResize} from "./files-panel-prefs";
import {PromptMarkdown} from "./MessageItem";
import {ImageViewer} from "./Lightbox";
import {TabIdContext} from "../../tab-context";
import {terminalText} from "../../terminal-text";
import {toolShortName, useMcpDisplayVersion} from "../../mcp-tool-display";

const cx = classNames.bind(styles);

// 백그라운드 작업 패널 — 작업 파일 패널 자리(오른쪽)에 붙는다. 입력창 위 작업 줄의 카드·답변 속 실행 줄을 누르면 열린다.
// 예전에는 떠 있는 창이라 대화를 가렸고, 바깥을 누르면 닫혀서 로그를 보면서 대화할 수 없었다. 위는 작업 목록(에이전트가
// 띄운 작업은 그 에이전트 밑), 아래는 고른 작업의 큰 실시간 로그.

// 고른 셸 작업의 출력 — 실행 중이면 이 간격으로 다시 읽는다. 큰 로그라 끝에서 넉넉히 읽는다.
const OUTPUT_POLL_MS = 1500;
const LOG_BYTES = 60_000;

interface Props {
    tabId: string;
    state: BackgroundState;
    selectedId: string | null;
    onSelect: (taskId: string) => void;
    canStopAll: boolean; // 응답 중에는 "모두 중지"가 응답까지 멈추므로 숨긴다
    onStopTask: (taskId: string) => void;
    onStopAll: () => void;
    onClearFinished: () => void;
    onOpenAgent?: (ref: AgentRef) => void; // 에이전트 작업 → "에이전트가 한 일" 패널 (작업 id = 에이전트 id)
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
}

export function BackgroundPanel({
    tabId,
    state,
    selectedId,
    onSelect,
    canStopAll,
    onStopTask,
    onStopAll,
    onClearFinished,
    onOpenAgent,
    width,
    onResize,
    onClose,
}: Props) {
    const running = runningOnly(state);
    const all = allTasks(state);
    const now = useNow(running.length > 0);
    const selected = all.find((t) => t.id === selectedId) ?? all.find((t) => t.running) ?? all[0] ?? null;

    // 실행 중인 작업을 띄운 쪽 밑으로 묶는다 (에이전트 → 그 에이전트가 띄운 셸)
    const runningIds = new Set(running.map((t) => t.id));
    const tree: {task: BackgroundTask; depth: number}[] = [];
    const seen = new Set<string>();
    const walk = (t: BackgroundTask, depth: number) => {
        if (seen.has(t.id)) return;
        seen.add(t.id);
        tree.push({task: t, depth});
        for (const c of running) if (c.parentTaskId === t.id) walk(c, depth + 1);
    };
    for (const t of running) if (!t.parentTaskId || !runningIds.has(t.parentTaskId)) walk(t, 0);

    const rowKeys = (id: string) => (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(id);
        }
    };

    return (
        <aside className={cx("filesPanel")} style={{width}}>
            <div className={cx("filesResize")} onPointerDown={(e) => startPanelResize(e, onResize)} title="끌어서 너비 조절" />
            <div className={cx("filesHeader")}>
                <span className={cx("filesTitle", "filesTitleRow")}>
                    <FontAwesomeIcon icon={faGears} className={cx("bgpTitleIcon")} />
                    <span>백그라운드 작업</span>
                    {running.length > 0 && <span className={cx("bgpCount")}>실행 중 {running.length}</span>}
                </span>
                {running.length > 0 && canStopAll && (
                    <button className={cx("bgpBtn", "bgpBtnDanger")} onClick={onStopAll}>
                        <FontAwesomeIcon icon={faStop} /> 모두 중지
                    </button>
                )}
                <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>

            {all.length === 0 ? (
                <div className={cx("bgpEmpty")}>
                    이 대화에서 도는 백그라운드 작업이 없습니다.
                    <br />
                    Claude가 dev 서버·테스트 감시처럼 오래 걸리는 명령을 띄우면 여기에 보입니다.
                </div>
            ) : (
                <>
                    <div className={cx("bgpList")}>
                        {tree.map(({task: t, depth}) => {
                            const kind = kindOf(t);
                            return (
                                <div
                                    key={t.id}
                                    role="button"
                                    tabIndex={0}
                                    className={cx("bgpRow", {bgpRowSel: selected?.id === t.id})}
                                    style={depth > 0 ? {paddingLeft: 8 + depth * 18} : undefined}
                                    onClick={() => onSelect(t.id)}
                                    onKeyDown={rowKeys(t.id)}
                                    title={t.description}
                                >
                                    <span className={cx("bgSpin")} />
                                    <FontAwesomeIcon icon={kind.icon} className={cx("bgpRowKind")} />
                                    <span className={cx("bgpRowName")}>{taskName(t)}</span>
                                    {t.type !== "local_bash" && <span className={cx("bgpTag")}>{kind.label}</span>}
                                    {taskTokens(t) && (
                                        <span className={cx("bgpRowTokens")} title={TOKENS_HINT}>
                                            {compactTokens(taskTokens(t) as number)}
                                        </span>
                                    )}
                                    {t.startedAt && <span className={cx("bgpRowTime")}>{formatElapsed(now - t.startedAt)}</span>}
                                    <button
                                        className={cx("bgpRowStop")}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onStopTask(t.id);
                                        }}
                                        title="이 작업만 중지"
                                    >
                                        <FontAwesomeIcon icon={faXmark} />
                                    </button>
                                </div>
                            );
                        })}
                        {running.length > 0 && (
                            <p className={cx("bgpHint")}>끝나면 Claude가 이어서 응답합니다. 다른 대화로 옮기면 바로 종료됩니다.</p>
                        )}

                        {state.finished.length > 0 && (
                            <div className={cx("bgpSection")}>
                                <span>최근 끝난 작업 {state.finished.length}</span>
                                <button className={cx("bgpClear")} onClick={onClearFinished} title="끝난 작업 기록 지우기">
                                    지우기
                                </button>
                            </div>
                        )}
                        {state.finished.map((f) => {
                            const kind = kindOf(f);
                            return (
                                <div
                                    key={f.id}
                                    role="button"
                                    tabIndex={0}
                                    className={cx("bgpRow", "bgpRowDone", {bgpRowSel: selected?.id === f.id})}
                                    onClick={() => onSelect(f.id)}
                                    onKeyDown={rowKeys(f.id)}
                                    title={f.description}
                                >
                                    <FontAwesomeIcon icon={statusInfo(f.status).icon} className={cx("bgpRowStatus", f.status)} />
                                    <FontAwesomeIcon icon={kind.icon} className={cx("bgpRowKind")} />
                                    <span className={cx("bgpRowName")}>{taskName(f)}</span>
                                    {f.status !== "completed" && <span className={cx("bgpRowResult", f.status)}>{finishedLabel(f)}</span>}
                                    {taskTokens(f) && (
                                        <span className={cx("bgpRowTokens")} title={TOKENS_HINT}>
                                            {compactTokens(taskTokens(f) as number)}
                                        </span>
                                    )}
                                    {f.startedAt && <span className={cx("bgpRowTime")}>{formatElapsed(f.endedAt - f.startedAt)}</span>}
                                </div>
                            );
                        })}
                    </div>

                    {selected && (
                        <TaskDetail
                            key={selected.id}
                            tabId={tabId}
                            task={selected}
                            now={now}
                            onStop={() => onStopTask(selected.id)}
                            onOpenAgent={onOpenAgent}
                        />
                    )}
                </>
            )}
        </aside>
    );
}

// 고른 작업의 자세한 내용 — 셸이면 큰 로그, 에이전트면 하는 일·쓴 도구
function TaskDetail({
    tabId,
    task,
    now,
    onStop,
    onOpenAgent,
}: {
    tabId: string;
    task: AnyTask;
    now: number;
    onStop: () => void;
    onOpenAgent?: (ref: AgentRef) => void;
}) {
    const kind = kindOf(task);
    // strict가 꺼져 있어 task.running으로는 좁혀지지 않는다 — 나눠 둔다
    const run = task.running ? (task as BackgroundTask) : null;
    const fin = task.running ? null : (task as FinishedTask);
    const status = fin
        ? `${finishedLabel(fin)}${fin.startedAt ? ` · ${formatElapsed(fin.endedAt - fin.startedAt)} 걸림` : ""}`
        : `실행 중${task.startedAt ? ` ${formatElapsed(now - task.startedAt)}` : ""}`;
    // 종료됨이면 CLI의 요약("… failed with exit code 143")은 빼고 위의 설명만 — 실패라고 적힌 문장이 설명과 어긋난다
    const activity = run
        ? (run.summary ?? run.activity)
        : fin?.summary && fin.summary !== fin.description && !fin.terminated
          ? fin.summary
          : undefined;
    return (
        <div className={cx("bgpDetail")}>
            <div className={cx("bgpDetailHead", fin?.status)}>
                {fin ? <FontAwesomeIcon icon={statusInfo(fin.status).icon} /> : <span className={cx("bgSpin")} />}
                <FontAwesomeIcon icon={kind.icon} />
                <span>
                    {kind.text} · {status}
                    {task.launchedByAgent && " · 에이전트가 실행"}
                </span>
            </div>
            <div className={cx("bgpDetailTitle")}>{task.description}</div>
            {task.command && <code className={cx("bgpCommand")}>{task.command}</code>}
            {fin?.terminated && <div className={cx("bgpActivity")}>{terminatedNote(fin)}</div>}
            {activity && <div className={cx("bgpActivity")}>{activity}</div>}
            {(task.toolUses != null || taskTokens(task) != null) && (
                <div className={cx("bgpMeta")} title={TOKENS_HINT}>
                    도구 {task.toolUses ?? 0}회 · 토큰 {(taskTokens(task) ?? 0).toLocaleString()}
                </div>
            )}
            <ToolSteps steps={task.recentTools} />
            {task.type === "local_agent" && onOpenAgent && (
                <button
                    className={cx("bgpLink")}
                    onClick={() => onOpenAgent({agentId: task.id, agentType: task.subagentType, description: task.description})}
                >
                    한 일 전체 보기 ›
                </button>
            )}
            {run?.prompt && (
                <details className={cx("bgpPrompt")}>
                    <summary>받은 지시 보기</summary>
                    <ImageViewer tabId={tabId}>
                        <div className={cx("bgpPromptBody")}>
                            <TabIdContext.Provider value={tabId}>
                                <PromptMarkdown text={run.prompt} />
                            </TabIdContext.Provider>
                        </div>
                    </ImageViewer>
                </details>
            )}
            {task.hasOutput ? (
                <LogView tabId={tabId} taskId={task.id} running={task.running} onStop={onStop} />
            ) : (
                task.running && (
                    <div className={cx("bgpFoot")}>
                        <span className={cx("bgpFootSpacer")} />
                        <button className={cx("bgpBtn", "bgpBtnDanger")} onClick={onStop}>
                            이 작업 중지
                        </button>
                    </div>
                )
            )}
        </div>
    );
}

// 셸 작업의 로그 — 새 출력이 오면 끝까지 따라간다. 위로 올려 읽는 동안은 그대로 두고 "맨 아래로"를 보인다.
function LogView({tabId, taskId, running, onStop}: {tabId: string; taskId: string; running: boolean; onStop: () => void}) {
    const [out, setOut] = useState<BackgroundOutput | null | undefined>(undefined);
    const ref = useRef<HTMLPreElement>(null);
    const followRef = useRef(true);
    const [follow, setFollow] = useState(true);
    const [copied, setCopied] = useState(false);
    // 터미널 제어 문자(색 등)를 뺀, 터미널에서 보이는 그대로의 글 — 화면과 "로그 복사"가 같이 쓴다
    const shown = useMemo(() => (out?.text ? terminalText(out.text) : ""), [out?.text]);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            const o = await window.electronAPI.getBackgroundOutput(tabId, taskId, LOG_BYTES);
            if (alive) setOut(o);
        };
        void load();
        if (!running) {
            return () => {
                alive = false;
            };
        }
        const timer = window.setInterval(load, OUTPUT_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [tabId, taskId, running]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (el && followRef.current) el.scrollTop = el.scrollHeight;
    }, [shown]);

    const onScroll = () => {
        const el = ref.current;
        if (!el) return;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
        if (atBottom !== followRef.current) {
            followRef.current = atBottom;
            setFollow(atBottom);
        }
    };
    const toBottom = () => {
        const el = ref.current;
        followRef.current = true;
        setFollow(true);
        if (el) el.scrollTop = el.scrollHeight;
    };
    const copy = () => {
        if (!shown) return;
        void copyText(shown).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    };

    return (
        <>
            <div className={cx("bgpLogWrap")}>
                {out === undefined ? (
                    <div className={cx("bgpLogEmpty")}>
                        <FontAwesomeIcon icon={faCircleNotch} spin /> 출력 불러오는 중…
                    </div>
                ) : !out || !shown.trim() ? (
                    <div className={cx("bgpLogEmpty")}>{running ? "아직 출력이 없습니다" : "출력이 없습니다"}</div>
                ) : (
                    <pre ref={ref} className={cx("bgpLog")} onScroll={onScroll}>
                        {out.truncated && <span className={cx("bgpLogCut")}>… 앞부분 생략{"\n"}</span>}
                        {shown}
                    </pre>
                )}
                {!follow && (
                    <button className={cx("bgpToBottom")} onClick={toBottom}>
                        <FontAwesomeIcon icon={faArrowDown} /> 맨 아래로
                    </button>
                )}
            </div>
            <div className={cx("bgpFoot")}>
                {running && follow && (
                    <span className={cx("bgpLive")}>
                        <span className={cx("bgpLiveDot")} />새 출력을 따라가는 중
                    </span>
                )}
                <span className={cx("bgpFootSpacer")} />
                <button className={cx("bgpBtn")} onClick={copy} disabled={!shown}>
                    <FontAwesomeIcon icon={copied ? faCheck : faCopy} /> {copied ? "복사됨" : "로그 복사"}
                </button>
                {running && (
                    <button className={cx("bgpBtn", "bgpBtnDanger")} onClick={onStop}>
                        이 작업 중지
                    </button>
                )}
            </div>
        </>
    );
}

// 에이전트가 최근에 쓴 도구
function ToolSteps({steps}: {steps?: ToolStep[]}) {
    useMcpDisplayVersion(); // 도구 이름 꾸미기(Figma)가 설정으로 바뀌면 다시 그린다
    if (!steps || steps.length === 0) return null;
    return (
        <div className={cx("bgSteps")}>
            {steps.map((st) => (
                <div key={st.id} className={cx("bgStep", st.status)}>
                    <FontAwesomeIcon
                        icon={st.status === "running" ? faCircleNotch : st.status === "error" ? faXmark : faCheck}
                        spin={st.status === "running"}
                        className={cx("bgStepIcon")}
                    />
                    <span className={cx("bgStepName")} title={st.name}>
                        {toolShortName(st.name)}
                    </span>
                    {st.target && (
                        <span className={cx("bgStepTarget")} title={st.target}>
                            {middleTruncate(st.target, 80)}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}
