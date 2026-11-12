import {useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faCircleNotch,
    faDiagramProject,
    faEye,
    faGears,
    faRobot,
    faStop,
    faTerminal,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import type {IconDefinition} from "@fortawesome/fontawesome-svg-core";
import styles from "./chat.page.module.scss";
import {middleTruncate} from "./ActivityPanel";

const cx = classNames.bind(styles);

const TYPE_INFO: Record<string, {label: string; icon: IconDefinition}> = {
    local_bash: {label: "셸 명령", icon: faTerminal},
    local_agent: {label: "에이전트", icon: faRobot},
    local_workflow: {label: "워크플로", icon: faDiagramProject},
    monitor: {label: "모니터", icon: faEye},
};

const STATUS_INFO: Record<FinishedTask["status"], {label: string; icon: IconDefinition}> = {
    completed: {label: "완료", icon: faCheck},
    failed: {label: "실패", icon: faTriangleExclamation},
    stopped: {label: "중지됨", icon: faStop},
};

// 셸 작업 출력은 패널이 열려 있는 동안만 이 간격으로 다시 읽는다
const OUTPUT_POLL_MS = 1500;

function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function kindLabel(t: {type: string; subagentType?: string; workflowName?: string}) {
    const info = TYPE_INFO[t.type] ?? {label: t.type, icon: faGears};
    return {icon: info.icon, text: [info.label, t.subagentType, t.workflowName].filter(Boolean).join(" · ")};
}

// 로그처럼 늘 마지막 줄이 보이게 아래로 붙여 둔다
function OutputTail({output}: {output: BackgroundOutput | null | undefined}) {
    const ref = useRef<HTMLPreElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [output?.text]);
    if (output === undefined) return <div className={cx("bgOutputEmpty")}>출력 불러오는 중…</div>;
    if (!output || !output.text.trim()) return <div className={cx("bgOutputEmpty")}>출력이 없습니다</div>;
    return (
        <pre ref={ref} className={cx("bgOutput")}>
            {output.truncated && <span className={cx("bgOutputCut")}>… 앞부분 생략{"\n"}</span>}
            {output.text}
        </pre>
    );
}

// 에이전트가 최근에 쓴 도구
function ToolSteps({steps}: {steps?: ToolStep[]}) {
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
                    <span className={cx("bgStepName")}>{st.name}</span>
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

interface Props {
    // 보고 있는 탭 — 셸 출력은 그 탭의 작업에서 읽는다
    tabId: string;
    tasks: BackgroundTask[];
    finished: FinishedTask[];
    top: number;
    canStopAll: boolean;
    onStopTask: (id: string) => void;
    onStopAll: () => void;
    onClearFinished: () => void;
    onClose: () => void;
}

// 상단 "백그라운드 N"을 누르면 뜨는 상세 패널: 실행 중인 작업 + 이 대화에서 최근 끝난 작업
export function BackgroundTasksPanel({
    tabId,
    tasks,
    finished,
    top,
    canStopAll,
    onStopTask,
    onStopAll,
    onClearFinished,
    onClose,
}: Props) {
    const [now, setNow] = useState(() => Date.now());
    const [outputs, setOutputs] = useState<Record<string, BackgroundOutput | null>>({});

    // 경과 시간
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    // 셸 작업의 최근 출력: 실행 중인 것은 계속 다시 읽고, 끝난 것은 한 번만 읽는다
    const runningIds = tasks.filter((t) => t.hasOutput).map((t) => t.id).join(",");
    const finishedIds = finished.filter((f) => f.hasOutput).map((f) => f.id).join(",");
    useEffect(() => {
        const ids = finishedIds ? finishedIds.split(",") : [];
        if (ids.length === 0) return;
        let alive = true;
        void Promise.all(ids.map(async (id) => [id, await window.electronAPI.getBackgroundOutput(tabId, id)] as const)).then(
            (entries) => alive && setOutputs((cur) => ({...cur, ...Object.fromEntries(entries)}))
        );
        return () => {
            alive = false;
        };
    }, [finishedIds, tabId]);
    useEffect(() => {
        const ids = runningIds ? runningIds.split(",") : [];
        if (ids.length === 0) return;
        let alive = true;
        const load = async () => {
            const entries = await Promise.all(
                ids.map(async (id) => [id, await window.electronAPI.getBackgroundOutput(tabId, id)] as const)
            );
            if (alive) setOutputs((cur) => ({...cur, ...Object.fromEntries(entries)}));
        };
        void load();
        const timer = window.setInterval(load, OUTPUT_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [runningIds, tabId]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <>
            <div className={cx("bgBackdrop")} onClick={onClose} />
            <div className={cx("bgPanel")} style={{top}} role="dialog" aria-label="백그라운드 작업">
                <div className={cx("bgList")}>
                    {tasks.length > 0 && (
                        <>
                            <div className={cx("bgPanelHeader")}>
                                <span className={cx("bgPanelTitle")}>
                                    <FontAwesomeIcon icon={faGears} /> 실행 중 {tasks.length}
                                </span>
                                {canStopAll && (
                                    <button className={cx("bgStopAll")} onClick={onStopAll}>
                                        <FontAwesomeIcon icon={faStop} /> 모두 중지
                                    </button>
                                )}
                            </div>
                            <p className={cx("bgPanelHint")}>
                                끝나면 Claude가 이어서 응답합니다. 설정을 바꾸면 다음 메시지를 보낼 때, 다른 대화로
                                옮기면 바로 종료됩니다.
                            </p>
                        </>
                    )}
                    {tasks.map((t) => {
                        const kind = kindLabel(t);
                        return (
                            <div key={t.id} className={cx("bgTask")}>
                                <div className={cx("bgTaskHead")}>
                                    <span className={cx("bgTaskType")}>
                                        <FontAwesomeIcon icon={kind.icon} /> {kind.text}
                                    </span>
                                    {t.startedAt && (
                                        <span className={cx("bgTaskElapsed")} title="경과 시간">
                                            {formatElapsed(now - t.startedAt)}
                                        </span>
                                    )}
                                    <button
                                        className={cx("bgTaskStop")}
                                        onClick={() => onStopTask(t.id)}
                                        title="이 작업만 중지"
                                    >
                                        <FontAwesomeIcon icon={faXmark} />
                                    </button>
                                </div>
                                <div className={cx("bgTaskDesc")}>{t.description}</div>
                                {t.launchedByAgent && <div className={cx("bgTaskMeta")}>에이전트가 실행한 작업</div>}
                                {t.command && (
                                    <code className={cx("bgTaskCommand")} title={t.command}>
                                        {middleTruncate(t.command, 160)}
                                    </code>
                                )}
                                {(t.summary || t.activity) && (
                                    <div className={cx("bgTaskActivity")}>{t.summary ?? t.activity}</div>
                                )}
                                {(t.toolUses != null || t.totalTokens != null) && (
                                    <div className={cx("bgTaskMeta")}>
                                        도구 {t.toolUses ?? 0}회 · 토큰 {(t.totalTokens ?? 0).toLocaleString()}
                                    </div>
                                )}
                                <ToolSteps steps={t.recentTools} />
                                {t.prompt && (
                                    <details className={cx("bgTaskPrompt")}>
                                        <summary>받은 지시 보기</summary>
                                        <p>{t.prompt}</p>
                                    </details>
                                )}
                                {t.hasOutput && <OutputTail output={outputs[t.id]} />}
                            </div>
                        );
                    })}

                    {finished.length > 0 && (
                        <div className={cx("bgPanelHeader", "bgFinishedHeader")}>
                            <span className={cx("bgPanelTitle")}>최근 끝난 작업 {finished.length}</span>
                            <button className={cx("bgClear")} onClick={onClearFinished} title="끝난 작업 기록 지우기">
                                지우기
                            </button>
                        </div>
                    )}
                    {finished.map((f) => {
                        const kind = kindLabel(f);
                        const status = STATUS_INFO[f.status];
                        return (
                            // 실패한 작업은 처음부터 펼쳐 에러 출력이 바로 보이게
                            <details
                                key={f.id}
                                className={cx("bgTask", "bgTaskDone")}
                                open={f.status === "failed" ? true : undefined}
                            >
                                <summary className={cx("bgTaskHead")}>
                                    <span className={cx("bgStatus", f.status)}>
                                        <FontAwesomeIcon icon={status.icon} /> {status.label}
                                        {f.exitCode != null && f.exitCode !== 0 && ` (코드 ${f.exitCode})`}
                                    </span>
                                    <span className={cx("bgTaskType")}>
                                        <FontAwesomeIcon icon={kind.icon} /> {kind.text}
                                    </span>
                                    {f.startedAt && (
                                        <span className={cx("bgTaskElapsed")} title="걸린 시간">
                                            {formatElapsed(f.endedAt - f.startedAt)}
                                        </span>
                                    )}
                                </summary>
                                <div className={cx("bgTaskDesc")}>{f.description}</div>
                                {f.command && (
                                    <code className={cx("bgTaskCommand")} title={f.command}>
                                        {middleTruncate(f.command, 160)}
                                    </code>
                                )}
                                {f.summary && f.summary !== f.description && (
                                    <div className={cx("bgTaskActivity")}>{f.summary}</div>
                                )}
                                {(f.toolUses != null || f.totalTokens != null) && (
                                    <div className={cx("bgTaskMeta")}>
                                        도구 {f.toolUses ?? 0}회 · 토큰 {(f.totalTokens ?? 0).toLocaleString()}
                                    </div>
                                )}
                                <ToolSteps steps={f.recentTools} />
                                {f.hasOutput && <OutputTail output={outputs[f.id]} />}
                            </details>
                        );
                    })}
                </div>
            </div>
        </>
    );
}
