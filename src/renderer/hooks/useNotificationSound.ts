import {useCallback, useState} from "react";

// 오디오 파일 대신 Web Audio로 합성한다.
// index.html의 CSP가 default-src 'self'라서 data: URI 오디오는 차단되는데,
// Vite는 작은 에셋을 자동으로 data: URI로 인라인해 버린다. 합성이면 이 문제가 없다.

const STORAGE_KEY = "better-claude:notification-sound";

function readEnabled(): boolean {
    try {
        return window.localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
        return true;
    }
}

let enabled = readEnabled();
let ctx: AudioContext | null = null;

function setEnabled(next: boolean): void {
    enabled = next;
    try {
        window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
        // 저장 실패는 무시 — 이번 실행 동안만 유지된다
    }
}

// 첫 재생은 사용자가 메시지를 보낸 뒤에 일어나므로 자동재생 정책에 걸리지 않는다.
// 그래도 컨텍스트가 suspended로 만들어지는 경우가 있어 매번 확인한다.
function getContext(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
}

// 사인파 하나만 쓰면 소리가 얄팍해서, 한 옥타브 위 배음을 작게 얹어 종소리에 가깝게 만든다.
function chime(ac: AudioContext, at: number, freq: number, peak: number): void {
    const partials: [number, number][] = [
        [1, 1],
        [2, 0.28],
    ];
    for (const [ratio, share] of partials) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = "sine";
        osc.frequency.value = freq * ratio;
        // 0에서 시작하지 않으면 딱 하는 클릭음이 난다. 감쇠는 지수로 — 0은 못 넣으므로 0.0001.
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(peak * share, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
        osc.connect(gain).connect(ac.destination);
        osc.start(at);
        osc.stop(at + 0.4);
    }
}

// 응답 완료 알림음 — A5 → E6로 살짝 올라가는 짧은 차임.
export function playCompletionSound(): void {
    if (!enabled) return;
    const ac = getContext();
    if (!ac) return;
    const now = ac.currentTime;
    chime(ac, now, 880, 0.16);
    chime(ac, now + 0.1, 1318.5, 0.13);
}

export function useNotificationSound() {
    const [soundEnabled, setSoundEnabled] = useState(enabled);

    const toggleSound = useCallback(() => {
        const next = !enabled;
        setEnabled(next);
        setSoundEnabled(next);
        // 켤 때 한 번 들려줘야 어떤 소리인지 알 수 있다
        if (next) playCompletionSound();
    }, []);

    return {soundEnabled, toggleSound} as const;
}
