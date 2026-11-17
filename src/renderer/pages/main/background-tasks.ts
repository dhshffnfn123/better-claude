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

// 끝난 작업의 상태 글: "완료" / "실패 · 코드 1" / "중지됨"
export function finishedLabel(f: {status: FinishedTask["status"]; exitCode?: number}): string {
    const base = STATUS_INFO[f.status].label;
    return f.status === "failed" && f.exitCode != null ? `${base} · 코드 ${f.exitCode}` : base;
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
