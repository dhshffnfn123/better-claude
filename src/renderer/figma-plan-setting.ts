import {useEffect, useState} from "react";
import {FIGMA_PLANS, type FigmaPlan} from "../shared/figma";

// Figma 요금제·좌석 — 호출 한도 표시(MCP 창의 figma 줄)의 기준. 사이드바 "설정"에서 고른다.
// 앱은 계정의 요금제를 알 수 없다(Figma 서버가 알려 주지 않는다). 기본은 Professional(Full·Dev 좌석)로,
// Full·Dev 좌석의 한도 중 가장 빠듯하다. 한도 숫자는 src/shared/figma.ts의 FIGMA_PLANS에 있다.
// 설정 창과 MCP 창이 같은 값을 보도록 여기서 한 번 읽어 나눠 준다 (jump-setting.ts와 같은 방식).

const KEY = "better-claude:figma-plan";

function read(): FigmaPlan {
    try {
        const v = localStorage.getItem(KEY);
        return v && v in FIGMA_PLANS ? (v as FigmaPlan) : "pro";
    } catch {
        return "pro";
    }
}

let current: FigmaPlan = read();
const listeners = new Set<(plan: FigmaPlan) => void>();

export function useFigmaPlan(): [FigmaPlan, (plan: FigmaPlan) => void] {
    const [plan, setPlan] = useState(current);
    useEffect(() => {
        listeners.add(setPlan);
        setPlan(current);
        return () => {
            listeners.delete(setPlan);
        };
    }, []);
    const set = (next: FigmaPlan) => {
        current = next;
        try {
            localStorage.setItem(KEY, next);
        } catch {
            // 저장이 막힌 환경 — 이번 실행 동안만
        }
        listeners.forEach((l) => l(next));
    };
    return [plan, set];
}
