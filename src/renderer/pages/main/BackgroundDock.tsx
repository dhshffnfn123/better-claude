import {Fragment, memo, useEffect, useReducer, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronRight, faCircleDot, faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {BackgroundLink} from "../../tab-context";
import {
    finishedLabel,
    formatElapsed,
    isShellTask,
    kindOf,
    lastOutputLine,
    runningOnly,
    statusInfo,
    taskName,
    taskTokens,
    useNow,
} from "./background-tasks";
import {compactTokens} from "../../token-format";
import {useTaskUrl} from "../../screen-compare";

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
    // [화면 찍기] — 셸 작업 출력에 이 컴퓨터 주소(dev 서버)가 보이면 그 화면을 찍어 화면 대조로 (Figma 기능을 끄면 없음)
    onCapture?: (url: string) => void;
}

type Card = {kind: "running"; task: BackgroundTask; children: number} | {kind: "done"; task: FinishedTask};

// 작업 줄에서 지운 끝난 작업 — id에 끝난 시각을 붙인다(다시 이어 돈 에이전트는 같은 id로 또 끝난다)
const doneKey = (f: FinishedTask) => `${f.id}@${f.endedAt}`;

export const BackgroundDock = memo(function BackgroundDock({tabId, active, state, panelOpen, panelTaskId, onOpen, onClosePanel, onCapture}: Props) {
    const running = runningOnly(state);
    const runningIds = new Set(running.map((t) => t.id));
    // 에이전트가 띄운 작업은 그 에이전트 카드에 묶는다 (패널에서는 그 밑에 보인다)
    const topLevel = running.filter((t) => !t.parentTaskId || !runningIds.has(t.parentTaskId));
    // 실행 중인 카드의 경과 시간 — 보이는 탭에서만 1초마다 다시 그린다
    useNow(active && running.length > 0);
    // 시각은 그릴 때마다 실제 시계로 잰다. 예전에는 위 타이머의 값을 썼는데, 타이머가 멈춰 있는 동안(다른 탭에 있을 때,
    // 실행 중인 작업이 없을 때) 그 값이 옛 시각에 머물러서 끝난 카드가 15초가 지나도 영영 남았다 — 다른 탭에 가 있는
    // 사이 끝난 작업, 사라지기 직전 1초 안에 다른 이유로 다시 그려진 카드("방금 끝남"이 계속 보임 — 재현됨).
    const now = Date.now();
    // "완료 지우기"·카드의 ×로 작업 줄에서만 지운 것. 패널의 "최근 끝난 작업"과 답변 속 실행 줄의 상태는 그대로 둔다 —
    // 끝난 작업의 로그는 거기서만 다시 볼 수 있다(패널에는 기록까지 지우는 "지우기"가 따로 있다).
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
    const recentDone = state.finished.filter(
        (f) => now - f.endedAt < RECENT_DONE_MS && !dismissed.has(doneKey(f)) && !(f.parentTaskId && runningIds.has(f.parentTaskId))
    );
    // 끝난 카드는 사라질 때 맞춰 다시 그린다 (탭이 숨어 있어도 — 돌아왔을 때 이미 사라져 있게)
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const nextExpiry = recentDone.length > 0 ? Math.min(...recentDone.map((f) => f.endedAt)) + RECENT_DONE_MS : 0;
    useEffect(() => {
        if (!nextExpiry) return;
        const timer = window.setTimeout(rerender, Math.max(0, nextExpiry - Date.now()) + 50);
        return () => window.clearTimeout(timer);
    }, [nextExpiry]);
    const dismiss = (list: FinishedTask[]) => {
        // 기록에서 빠진 것(패널의 지우기, 새 대화)은 같이 잊는다
        const kept = new Set(state.finished.map(doneKey));
        setDismissed((prev) => new Set([...[...prev].filter((k) => kept.has(k)), ...list.map(doneKey)]));
    };

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
        const tokens = taskTokens(c.task);
        const tokenText = tokens ? ` · 토큰 ${compactTokens(tokens)}` : "";
        if (c.kind === "done") {
            const t = c.task;
            const took = t.startedAt ? ` · ${formatElapsed(t.endedAt - t.startedAt)}` : "";
            return `${finishedLabel(t)}${took}${tokenText}`;
        }
        const t = c.task;
        const extra = c.children > 0 ? ` · 작업 ${c.children}개 실행 중` : "";
        if (isShellTask(t)) return (lines[t.id] ?? (t.hasOutput ? "출력 기다리는 중" : "출력 없음")) + extra;
        // 에이전트: 쓴 토큰을 앞에 — 하는 일 글이 길어 잘려도 토큰은 보이게
        const activity = t.summary ?? t.activity;
        const label = kindOf(t).label + (tokens ? ` · 토큰 ${compactTokens(tokens)}` : "");
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
                // 끝난 카드에는 지우기(×)가 들어가서 카드 자체는 button이 아니다(button 안에 button을 둘 수 없다)
                return (
                    <Fragment key={t.id}>
                        <div
                            role="button"
                            tabIndex={0}
                            className={cx("bgChip", {
                                bgChipSel: panelOpen && panelTaskId === t.id,
                                bgChipFailed: done?.status === "failed",
                                bgChipDone: done && done.status !== "failed",
                            })}
                            onClick={() => onOpen(t.id)}
                            onKeyDown={(e) => {
                                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                                e.preventDefault();
                                onOpen(t.id);
                            }}
                            title={[t.description, t.command].filter(Boolean).join("\n") + "\n\n눌러서 오른쪽 패널에서 보기"}
                        >
                            <span className={cx("bgChipHead")}>
                                {done ? (
                                    <FontAwesomeIcon icon={statusInfo(done.status).icon} className={cx("bgChipStatus", done.status)} />
                                ) : (
                                    <span className={cx("bgSpin")} />
                                )}
                                <FontAwesomeIcon icon={kind.icon} className={cx("bgChipKind")} />
                                <span className={cx("bgChipName")}>{taskName(t)}</span>
                                {!done && t.startedAt && <span className={cx("bgChipTime")}>{formatElapsed(now - t.startedAt)}</span>}
                                {done && (
                                    <button
                                        className={cx("bgChipDismiss")}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            dismiss([done]);
                                        }}
                                        title="작업 줄에서 지우기 (패널의 기록은 남습니다)"
                                        aria-label="작업 줄에서 지우기"
                                    >
                                        <FontAwesomeIcon icon={faXmark} />
                                    </button>
                                )}
                            </span>
                            <span className={cx("bgChipLine")}>{secondLine(c)}</span>
                        </div>
                        {c.kind === "running" && onCapture && (
                            <CaptureChip tabId={tabId} task={c.task} active={active} onCapture={onCapture} />
                        )}
                    </Fragment>
                );
            })}
            {hidden > 0 && (
                <button className={cx("bgDockMore")} onClick={() => onOpen(null)} title="나머지 작업은 오른쪽 패널에서 봅니다">
                    +{hidden}
                </button>
            )}
            </div>
            {recentDone.length > 0 && (
                <button
                    className={cx("bgDockOpen")}
                    onClick={() => dismiss(recentDone)}
                    title="끝난 작업 카드를 작업 줄에서 지웁니다 — 오른쪽 패널의 기록과 로그는 남습니다"
                >
                    완료 지우기
                </button>
            )}
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

// dev 서버 카드 옆 [화면 찍기] — 출력에 이 컴퓨터 주소(http://localhost:5173 등)가 나온 셸 작업만. 누르면 화면 대조 패널이
// 열리며 그 주소를 찍는다. 주소는 출력이 나올 때까지 몇 초마다 다시 읽는다(보이는 탭에서만).
function CaptureChip({tabId, task, active, onCapture}: {tabId: string; task: BackgroundTask; active: boolean; onCapture: (url: string) => void}) {
    const url = useTaskUrl(tabId, task, active);
    if (!url) return null;
    return (
        <button className={cx("bgCapture")} onClick={() => onCapture(url)} title={`${url} 화면을 찍어 디자인과 맞대 봅니다`}>
            <FontAwesomeIcon icon={faCircleDot} /> 화면 찍기
        </button>
    );
}

// 답변 속 실행 줄의 상태 — "백그라운드 · 실행 중 1:51" / "완료 · 3:02" / "실패 · 코드 1". 누르면 패널에서 연다.
// link가 없으면(앱을 다시 켰거나 끝난 기록을 지움) 백그라운드로 띄웠다는 것만 보인다.
export function BackgroundBadge({link, onOpen}: {link: BackgroundLink | null; onOpen?: (taskId: string) => void}) {
    const now = useNow(!!link?.running);
    if (!link) return <span className={cx("bgBadge")}>백그라운드</span>;
    const text = link.running
        ? `백그라운드 · 실행 중${link.startedAt ? ` ${formatElapsed(now - link.startedAt)}` : ""}`
        : `${finishedLabel({status: link.status ?? "completed", exitCode: link.exitCode, terminated: link.terminated})}${
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
