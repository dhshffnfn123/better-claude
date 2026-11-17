import {memo, useEffect, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronRight} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {BackgroundLink} from "../../tab-context";
import {
    finishedLabel,
    formatElapsed,
    isShellTask,
    kindOf,
    lastOutputLine,
    runningOnly,
    STATUS_INFO,
    taskName,
    useNow,
} from "./background-tasks";

const cx = classNames.bind(styles);

// 입력창 바로 위 작업 줄 — 실행 중인 백그라운드 작업을 카드로 늘 보여 준다. 예전에는 작업 폴더 줄 오른쪽 끝의
// 11px 회색 "백그라운드 N"뿐이라 눈에 띄지 않았다. 카드를 누르면 오른쪽 패널이 그 작업으로 열린다.

// 끝난 작업을 작업 줄에 남겨 두는 시간 — 끝났다는 걸 보여 주고 사라진다(그 뒤로는 패널·답변 속 줄에서 본다)
const RECENT_DONE_MS = 15_000;
const MAX_CARDS = 3;
// 셸 작업 카드의 마지막 출력 한 줄 — 보이는 탭에서만 이 간격으로 읽는다
const LINE_POLL_MS = 2000;
const LINE_BYTES = 2000;

interface Props {
    tabId: string;
    active: boolean;
    state: BackgroundState;
    panelOpen: boolean;
    panelTaskId: string | null;
    onOpen: (taskId: string | null) => void;
    onClosePanel: () => void;
}

type Card = {kind: "running"; task: BackgroundTask; children: number} | {kind: "done"; task: FinishedTask};

export const BackgroundDock = memo(function BackgroundDock({tabId, active, state, panelOpen, panelTaskId, onOpen, onClosePanel}: Props) {
    const running = runningOnly(state);
    const runningIds = new Set(running.map((t) => t.id));
    // 에이전트가 띄운 작업은 그 에이전트 카드에 묶는다 (패널에서는 그 밑에 보인다)
    const topLevel = running.filter((t) => !t.parentTaskId || !runningIds.has(t.parentTaskId));
    const hasRecentDone = state.finished.some((f) => Date.now() - f.endedAt < RECENT_DONE_MS);
    const now = useNow(active && (running.length > 0 || hasRecentDone));
    const recentDone = state.finished.filter((f) => now - f.endedAt < RECENT_DONE_MS && !(f.parentTaskId && runningIds.has(f.parentTaskId)));

    const cards: Card[] = [
        ...topLevel.map((t) => ({kind: "running" as const, task: t, children: running.filter((c) => c.parentTaskId === t.id).length})),
        ...recentDone.map((f) => ({kind: "done" as const, task: f})),
    ];
    const shown = cards.slice(0, MAX_CARDS);
    const hidden = cards.length - shown.length;

    // 셸 작업의 마지막 출력 한 줄
    const [lines, setLines] = useState<Record<string, string | undefined>>({});
    const pollIds = shown
        .filter((c) => c.kind === "running" && isShellTask(c.task) && c.task.hasOutput)
        .map((c) => c.task.id)
        .join(",");
    useEffect(() => {
        if (!active || !pollIds) return;
        const ids = pollIds.split(",");
        let alive = true;
        const load = async () => {
            const entries = await Promise.all(
                ids.map(async (id) => [id, lastOutputLine((await window.electronAPI.getBackgroundOutput(tabId, id, LINE_BYTES))?.text)] as const)
            );
            if (alive) setLines((cur) => ({...cur, ...Object.fromEntries(entries)}));
        };
        void load();
        const timer = window.setInterval(load, LINE_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [active, pollIds, tabId]);

    if (cards.length === 0) return null;

    const secondLine = (c: Card): string => {
        if (c.kind === "done") {
            const t = c.task;
            const took = t.startedAt ? ` · ${formatElapsed(t.endedAt - t.startedAt)}` : "";
            return `${finishedLabel(t)}${took}`;
        }
        const t = c.task;
        const extra = c.children > 0 ? ` · 작업 ${c.children}개 실행 중` : "";
        if (isShellTask(t)) return (lines[t.id] ?? (t.hasOutput ? "출력 기다리는 중" : "출력 없음")) + extra;
        const activity = t.summary ?? t.activity;
        const label = kindOf(t).label;
        return (activity ? `${label} · ${activity}` : t.toolUses != null ? `${label} · 도구 ${t.toolUses}회` : label) + extra;
    };

    return (
        <div className={cx("bgDock")}>
            <div className={cx("bgDockLabel")} title={`실행 중인 백그라운드 작업 ${running.length}개`}>
                {running.length > 0 ? (
                    <>
                        <span className={cx("bgDockCount")}>{running.length}</span>
                        백그라운드
                    </>
                ) : (
                    // 도는 건 없고 방금 끝난 카드만 남았다
                    "방금 끝남"
                )}
            </div>
            <div className={cx("bgDockCards")}>
            {shown.map((c) => {
                const t = c.task;
                const kind = kindOf(t);
                const done = c.kind === "done" ? c.task : null;
                return (
                    <button
                        key={t.id}
                        className={cx("bgChip", {
                            bgChipSel: panelOpen && panelTaskId === t.id,
                            bgChipFailed: done?.status === "failed",
                            bgChipDone: done && done.status !== "failed",
                        })}
                        onClick={() => onOpen(t.id)}
                        title={[t.description, t.command].filter(Boolean).join("\n") + "\n\n눌러서 오른쪽 패널에서 보기"}
                    >
                        <span className={cx("bgChipHead")}>
                            {done ? (
                                <FontAwesomeIcon icon={STATUS_INFO[done.status].icon} className={cx("bgChipStatus", done.status)} />
                            ) : (
                                <span className={cx("bgSpin")} />
                            )}
                            <FontAwesomeIcon icon={kind.icon} className={cx("bgChipKind")} />
                            <span className={cx("bgChipName")}>{taskName(t)}</span>
                            {!done && t.startedAt && <span className={cx("bgChipTime")}>{formatElapsed(now - t.startedAt)}</span>}
                        </span>
                        <span className={cx("bgChipLine")}>{secondLine(c)}</span>
                    </button>
                );
            })}
            {hidden > 0 && (
                <button className={cx("bgDockMore")} onClick={() => onOpen(null)} title="나머지 작업은 오른쪽 패널에서 봅니다">
                    +{hidden}
                </button>
            )}
            </div>
            <button className={cx("bgDockOpen")} onClick={panelOpen ? onClosePanel : () => onOpen(null)}>
                {panelOpen ? (
                    "패널 닫기"
                ) : (
                    <>
                        패널로 보기 <FontAwesomeIcon icon={faChevronRight} />
                    </>
                )}
            </button>
        </div>
    );
});

// 답변 속 실행 줄의 상태 — "백그라운드 · 실행 중 1:51" / "완료 · 3:02" / "실패 · 코드 1". 누르면 패널에서 연다.
// link가 없으면(앱을 다시 켰거나 끝난 기록을 지움) 백그라운드로 띄웠다는 것만 보인다.
export function BackgroundBadge({link, onOpen}: {link: BackgroundLink | null; onOpen?: (taskId: string) => void}) {
    const now = useNow(!!link?.running);
    if (!link) return <span className={cx("bgBadge")}>백그라운드</span>;
    const text = link.running
        ? `백그라운드 · 실행 중${link.startedAt ? ` ${formatElapsed(now - link.startedAt)}` : ""}`
        : `${finishedLabel({status: link.status ?? "completed", exitCode: link.exitCode})}${
              link.startedAt && link.endedAt ? ` · ${formatElapsed(link.endedAt - link.startedAt)}` : ""
          }`;
    return (
        <button
            className={cx("bgBadge", {
                bgBadgeRunning: link.running,
                bgBadgeFailed: link.status === "failed",
                bgBadgeDone: !link.running && link.status !== "failed",
            })}
            onClick={(e) => {
                e.stopPropagation();
                onOpen?.(link.taskId);
            }}
            title="오른쪽 패널에서 이 작업 보기"
        >
            {text}
        </button>
    );
}
