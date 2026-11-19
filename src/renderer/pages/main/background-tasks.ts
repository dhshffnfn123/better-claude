import {useEffect, useState} from "react";
import type {IconDefinition} from "@fortawesome/fontawesome-svg-core";
import {
    faCheck,
    faDiagramProject,
    faEye,
    faGears,
    faRobot,
    faStop,
    faTerminal,
    faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";

// 백그라운드 작업을 그리는 곳들(입력창 위 작업 줄, 오른쪽 패널, 답변 속 실행 줄)이 같이 쓰는 것.
// 컴포넌트 파일에서 컴포넌트가 아닌 것을 내보내면 Fast Refresh가 꺼져서 따로 둔다.

const TYPE_INFO: Record<string, {label: string; icon: IconDefinition}> = {
    local_bash: {label: "셸 명령", icon: faTerminal},
    local_agent: {label: "에이전트", icon: faRobot},
    local_workflow: {label: "워크플로", icon: faDiagramProject},
    monitor: {label: "모니터", icon: faEye},
};

export const STATUS_INFO: Record<FinishedTask["status"], {label: string; icon: IconDefinition}> = {
    completed: {label: "완료", icon: faCheck},
    failed: {label: "실패", icon: faTriangleExclamation},
    stopped: {label: "중지됨", icon: faStop},
};

export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// 종류: 아이콘 + "셸 명령" / "에이전트 · general-purpose" 같은 이름
export function kindOf(t: {type: string; subagentType?: string; workflowName?: string}): {icon: IconDefinition; label: string; text: string} {
    const info = TYPE_INFO[t.type] ?? {label: t.type, icon: faGears};
    return {icon: info.icon, label: info.label, text: [info.label, t.subagentType, t.workflowName].filter(Boolean).join(" · ")};
}

export function isShellTask(t: {type: string}): boolean {
    return t.type === "local_bash";
}

// 작업 이름 — Claude가 붙인 설명. 영어 설명 끝의 "in background"는 뗀다(어차피 백그라운드 작업 목록이다).
export function taskName(t: {description: string; command?: string}): string {
    const d = t.description.trim().replace(/\s+(?:in|into)\s+(?:the\s+)?background\.?$/i, "");
    return d || t.command || "이름 없는 작업";
}

// 작업이 쓴 토큰 — 에이전트가 모델 호출마다 쓴 토큰의 합(main이 응답마다 더함). 그게 없으면 CLI가 알려 준 값.
// 셸 명령은 모델을 부르지 않아 토큰이 없다(undefined).
export function taskTokens(t: {type: string; usedTokens?: number; totalTokens?: number}): number | undefined {
    if (isShellTask(t)) return undefined;
    const n = t.usedTokens ?? t.totalTokens;
    return n && n > 0 ? n : undefined;
}

export const TOKENS_HINT = "이 작업이 모델 호출에 쓴 토큰 (입력·캐시·출력 합계)";

// 끝난 작업의 상태 글: "완료" / "실패 · 코드 1" / "중지됨"
// 다른 명령이 신호로 끝낸 셸 (main의 TERMINATED_EXIT_CODES — 예전엔 "실패 · 코드 143"으로 빨갛게 보였다):
// dev 서버·감시처럼 스스로 끝나지 않는 명령이면 status가 completed로 와서 "완료", 그 밖(빌드·테스트 …)은 "종료됨".
// 모르는 상태가 와도 화면이 깨지지 않게 "중지됨"으로 그린다.
export function finishedLabel(f: {status: FinishedTask["status"]; exitCode?: number; terminated?: boolean}): string {
    if (f.terminated) return f.status === "completed" ? "완료" : "종료됨";
    const base = statusInfo(f.status).label;
    return f.status === "failed" && f.exitCode != null ? `${base} · 코드 ${f.exitCode}` : base;
}

export function statusInfo(status: string): {label: string; icon: IconDefinition} {
    return STATUS_INFO[status as FinishedTask["status"]] ?? STATUS_INFO.stopped;
}

// 다른 명령이 끝낸 작업에 덧붙이는 설명 (패널의 자세히)
export function terminatedNote(f: {status: FinishedTask["status"]; exitCode?: number}): string {
    const code = f.exitCode != null ? ` (종료 신호 · 코드 ${f.exitCode})` : "";
    return f.status === "completed"
        ? `dev 서버·감시처럼 스스로 끝나지 않는 명령이라, 다른 명령이 끈 것을 정상적인 끝으로 봤습니다${code}`
        : `다른 명령(kill 등)이 도중에 끝냈습니다 — 오류로 멈춘 게 아닙니다${code}`;
}

// 출력의 마지막 줄 — 빈 줄과 끝에 붙는 "[exited with code N]"은 건너뛴다
export function lastOutputLine(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line && !/^\[exited with code \d+\]$/.test(line)) return line;
    }
    return undefined;
}

// 이 도구 호출이 작업을 백그라운드로 띄웠나 (작업 정보가 없을 때 — 앱을 다시 켰거나 끝난 기록을 지웠을 때)
export function launchedInBackground(name: string, input: unknown): boolean {
    if (name !== "Bash" && name !== "Agent" && name !== "Task") return false;
    return !!input && typeof input === "object" && (input as {run_in_background?: unknown}).run_in_background === true;
}

// 실행 중 + 끝난 작업. 끝나는 순간에는 두 목록에 잠깐 같이 있다(끝남 기록 → 목록 갱신 순서) — 끝난 쪽을 쓴다.
export type AnyTask = (BackgroundTask & {running: true}) | (FinishedTask & {running: false});

export function runningOnly(state: BackgroundState): BackgroundTask[] {
    const done = new Set(state.finished.map((f) => f.id));
    return state.running.filter((t) => !done.has(t.id));
}

export function allTasks(state: BackgroundState): AnyTask[] {
    return [
        ...runningOnly(state).map((t) => ({...t, running: true as const})),
        ...state.finished.map((f) => ({...f, running: false as const})),
    ];
}

// on인 동안 ms마다 바뀌는 현재 시각 (경과 시간 표시)
export function useNow(on: boolean, ms = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!on) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), ms);
        return () => window.clearInterval(timer);
    }, [on, ms]);
    return now;
}
