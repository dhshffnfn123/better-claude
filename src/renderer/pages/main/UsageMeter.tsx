import {useEffect, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChartSimple} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {compactTokens, formatCost, totalTokens} from "../../token-format";
import {MiddleName} from "./MiddleName";

const cx = classNames.bind(styles);

// 헤더의 탭별 누적 사용량. 버튼에는 보고 있는 탭의 누적 토큰, 누르면 열린 탭마다 토큰·예상 비용과 합계.
// 숫자는 CLI가 응답마다 알려 주는 대화 누계(modelUsage)다 — 본 대화·에이전트·백그라운드 작업·요약이 모두 들어가고,
// 같은 대화를 다시 열면 이어서 센다. 아직 한 번도 보지 않은 복원 탭은 저장해 둔 누계를 main에서 읽어 온다.

export interface UsageTab {
    id: string;
    title: string;
    folder: string;
    sessionId: string | null;
    usage: TokenTotals | null;
    cost: number | null;
}

function breakdown(u: TokenTotals): string {
    return `입력 ${compactTokens(u.input)} · 출력 ${compactTokens(u.output)} · 캐시 읽기 ${compactTokens(u.cacheRead)} · 캐시 쓰기 ${compactTokens(u.cacheWrite)}`;
}

export function UsageMeter({tabs, activeId, onSelect}: {tabs: UsageTab[]; activeId: string; onSelect: (tabId: string) => void}) {
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState<Record<string, {cost?: number; usage?: TokenTotals}>>({});

    // 연 동안: 아직 누계가 없는 탭(복원만 되고 열지 않은 탭)의 저장된 값을 읽는다
    const missingKey = tabs
        .filter((t) => !t.usage && t.sessionId)
        .map((t) => t.sessionId)
        .join(",");
    useEffect(() => {
        if (!open || !missingKey) return;
        let alive = true;
        void window.electronAPI.getSessionStats(missingKey.split(",")).then((r) => {
            if (alive) setSaved(r);
        });
        return () => {
            alive = false;
        };
    }, [open, missingKey]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    const rows = tabs.map((t) => {
        const s = t.sessionId ? saved[t.sessionId] : undefined;
        return {...t, usage: t.usage ?? s?.usage ?? null, cost: t.cost ?? s?.cost ?? null};
    });
    const sumTokens = rows.reduce((n, r) => n + (r.usage ? totalTokens(r.usage) : 0), 0);
    const sumCost = rows.reduce((n, r) => n + (r.cost ?? 0), 0);
    const active = rows.find((r) => r.id === activeId);
    const activeTotal = active?.usage ? totalTokens(active.usage) : null;

    const tooltip =
        activeTotal !== null
            ? `이 탭 누적 ${compactTokens(activeTotal)} 토큰${active?.cost != null ? ` · ${formatCost(active.cost)}` : ""} — 눌러서 탭별로 보기`
            : "이 탭은 아직 사용량이 없습니다 — 눌러서 탭별로 보기";

    return (
        <span className={cx("notifyWrap")}>
            <button
                className={cx("usageChip", {usageChipOpen: open})}
                onClick={() => setOpen((v) => !v)}
                data-tooltip={open ? undefined : tooltip}
                data-tooltip-dir="down"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label="탭별 누적 사용량"
            >
                <FontAwesomeIcon icon={faChartSimple} />
                {activeTotal !== null ? compactTokens(activeTotal) : "—"}
            </button>
            {open && (
                <>
                    <div className={cx("mcpBackdrop")} onClick={() => setOpen(false)} />
                    <div className={cx("notifyPopover", "usagePopover")} role="dialog" aria-label="탭별 누적 사용량">
                        <div className={cx("notifyTitle")}>탭별 누적 사용량</div>
                        <div className={cx("usageList")}>
                            {rows.map((r) => (
                                <button
                                    key={r.id}
                                    className={cx("usageRow", {usageRowActive: r.id === activeId})}
                                    onClick={() => {
                                        onSelect(r.id);
                                        setOpen(false);
                                    }}
                                    title={r.usage ? breakdown(r.usage) : "아직 사용량이 없습니다"}
                                >
                                    <span className={cx("usageRowName")}>
                                        {r.folder && (
                                            <span className={cx("usageFolder")}>
                                                <MiddleName name={r.folder} />
                                            </span>
                                        )}
                                        <span className={cx("usageTitle")}>{r.title}</span>
                                    </span>
                                    <span className={cx("usageTokens")}>{r.usage ? compactTokens(totalTokens(r.usage)) : "—"}</span>
                                    <span className={cx("usageCost")}>{r.cost != null ? formatCost(r.cost) : ""}</span>
                                </button>
                            ))}
                        </div>
                        <div className={cx("usageTotal")}>
                            <span className={cx("usageRowName")}>합계 · 탭 {rows.length}개</span>
                            <span className={cx("usageTokens")}>{compactTokens(sumTokens)}</span>
                            <span className={cx("usageCost")}>{formatCost(sumCost)}</span>
                        </div>
                        {active?.usage && <div className={cx("usageBreakdown")}>이 탭: {breakdown(active.usage)}</div>}
                        <div className={cx("notifyHint")}>
                            토큰 = 입력 + 출력 + 캐시(읽기·쓰기). 에이전트·백그라운드 작업도 들어갑니다. 대화마다 쌓이고, 같은
                            대화를 다시 열면 이어서 셉니다. 비용은 예상치입니다.
                        </div>
                    </div>
                </>
            )}
        </span>
    );
}
