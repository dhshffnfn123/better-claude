import {useEffect, useState} from "react";
import classNames from "classnames/bind";
import styles from "./chat.page.module.scss";
import {FIGMA_PLANS, figmaDayKey} from "../../../shared/figma";
import {useFigmaPlan} from "../../figma-plan-setting";
import {useFigmaFeatures} from "../../figma-setting";
import {useNow} from "./background-tasks";

const cx = classNames.bind(styles);

// MCP 창의 figma 줄 밑 — Figma 읽기 호출 수와 요금제 한도. 셈은 main(figma-usage.ts)이 한다.
// "최근 1분"은 시간이 지나면 줄어야 해서 화면이 호출 시각으로 다시 센다.
const WARN_RATIO = 0.8;

export function FigmaUsageLine() {
    const [figmaOn] = useFigmaFeatures();
    const [usage, setUsage] = useState<FigmaUsage | null>(null);
    const [planId] = useFigmaPlan();
    const plan = FIGMA_PLANS[planId];
    useEffect(() => {
        let alive = true;
        void window.electronAPI.getFigmaUsage().then((u) => {
            if (alive) setUsage(u);
        });
        const off = window.electronAPI.onFigmaUsage(setUsage);
        return () => {
            alive = false;
            off();
        };
    }, []);
    const now = useNow(!!usage && usage.recent.some((t) => Date.now() - t < 60_000));
    // 설정에서 Figma 기능을 끄면 숨긴다 (main은 계속 센다)
    if (!usage || !figmaOn) return null;

    const today = usage.days[figmaDayKey(now)] ?? 0;
    const month = Object.entries(usage.days)
        .filter(([k]) => k.startsWith(figmaDayKey(now).slice(0, 8)))
        .reduce((n, [, v]) => n + v, 0);
    const minute = usage.recent.filter((t) => now - t < 60_000).length;

    const ratios = [
        plan.perDay ? today / plan.perDay : 0,
        plan.perMinute ? minute / plan.perMinute : 0,
        plan.perMonth ? month / plan.perMonth : 0,
    ];
    const worst = Math.max(...ratios);
    const main = plan.perMonth
        ? `이번 달 읽기 ${month} / ${plan.perMonth}회`
        : `오늘 읽기 ${today}${plan.perDay ? ` / ${plan.perDay}` : ""}회`;
    const perMinute = `최근 1분 ${minute}${plan.perMinute ? ` / ${plan.perMinute}` : ""}회`;

    return (
        <div
            className={cx("figmaUsage", {figmaUsageWarn: worst >= WARN_RATIO && worst < 1, figmaUsageOver: worst >= 1})}
            title={`${plan.title} — ${plan.desc}\n요금제·좌석은 사이드바 설정에서 바꿉니다. 한도는 Figma 문서 기준이며 Figma가 바꿀 수 있습니다.`}
        >
            <span className={cx("figmaUsageCounts")}>
                {main} · {perMinute}
            </span>
            <span className={cx("figmaUsageNote")}>
                {worst >= 1 ? "한도에 닿았습니다 — " : worst >= WARN_RATIO ? "한도에 가깝습니다 — " : ""}
                {plan.title} 기준 · 이 앱에서 보낸 호출만 셉니다 (쓰기는 빠짐)
            </span>
        </div>
    );
}
