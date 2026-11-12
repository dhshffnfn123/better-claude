import {useCallback, useState} from "react";

// 알림음과 macOS 알림. 설정은 이 기기에만 저장한다(localStorage).
//
// 소리는 오디오 파일 대신 Web Audio로 합성한다.
// index.html의 CSP가 default-src 'self'라서 data: URI 오디오는 차단되는데,
// Vite는 작은 에셋을 자동으로 data: URI로 인라인해 버린다. 합성이면 이 문제가 없다.

const SOUND_KEY = "better-claude:notification-sound"; // "on" | "off"
const VOLUME_KEY = "better-claude:notification-volume"; // 0~100, 50이 예전 크기
const OS_KEY = "better-claude:os-notifications"; // "on" | "off"

export const DEFAULT_VOLUME = 50;

function read(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // 저장 실패는 무시 — 이번 실행 동안만 유지된다
    }
}

function clampVolume(v: number): number {
    return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : DEFAULT_VOLUME;
}

let enabled = read(SOUND_KEY) !== "off";
let volume = clampVolume(Number(read(VOLUME_KEY) ?? DEFAULT_VOLUME));
let osEnabled = read(OS_KEY) !== "off";
let ctx: AudioContext | null = null;

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

// 두 음을 이어 친다. 음량 50%가 예전 크기, 100%면 두 배.
function playNotes(notes: [number, number, number][]): void {
    if (volume <= 0) return;
    const ac = getContext();
    if (!ac) return;
    const scale = volume / DEFAULT_VOLUME;
    const now = ac.currentTime;
    for (const [delay, freq, peak] of notes) chime(ac, now + delay, freq, peak * scale);
}

// 응답 완료 — A5 → E6로 살짝 올라가는 짧은 차임.
function completionNotes(): void {
    playNotes([
        [0, 880, 0.16],
        [0.1, 1318.5, 0.13],
    ]);
}

export function playCompletionSound(): void {
    if (enabled) completionNotes();
}

// Claude가 허용·답을 기다린다 — 완료음과 구분되게 E6 → B5로 내려간다.
function playAttentionSound(): void {
    if (enabled) {
        playNotes([
            [0, 1318.5, 0.14],
            [0.12, 987.8, 0.13],
        ]);
    }
}

// 창이 앞에 있고 포커스가 있으면 사용자가 보고 있는 것으로 본다
function isAway(): boolean {
    return !document.hasFocus();
}

function showOsNotification(title: string, body: string): void {
    if (osEnabled) void window.electronAPI.showNotification({title, body});
}

// 응답이 끝났다: 소리는 늘(예전과 같다), macOS 알림은 앱을 보고 있지 않을 때만.
export function notifyTurnDone(title: string, body: string): void {
    playCompletionSound();
    if (isAway()) showOsNotification(title, body);
}

// 허용 요청·질문: 앱을 보고 있으면 화면의 창으로 충분하다 — 보고 있지 않을 때만 소리와 알림.
export function notifyNeedsInput(title: string, body: string): void {
    if (!isAway()) return;
    playAttentionSound();
    showOsNotification(title, body);
}

export function useNotificationSettings() {
    const [state, setState] = useState(() => ({soundEnabled: enabled, volume, osEnabled}));

    const setSoundEnabled = useCallback((next: boolean) => {
        enabled = next;
        write(SOUND_KEY, next ? "on" : "off");
        setState((s) => ({...s, soundEnabled: next}));
        // 켤 때 한 번 들려줘야 어떤 소리인지 알 수 있다
        if (next) completionNotes();
    }, []);

    const setVolume = useCallback((next: number) => {
        volume = clampVolume(next);
        write(VOLUME_KEY, String(volume));
        setState((s) => ({...s, volume}));
    }, []);

    const setOsEnabled = useCallback((next: boolean) => {
        osEnabled = next;
        write(OS_KEY, next ? "on" : "off");
        setState((s) => ({...s, osEnabled: next}));
    }, []);

    // 지금 음량으로 들어 보기 (알림음이 꺼져 있어도)
    const preview = useCallback(() => completionNotes(), []);

    // 보고 있어도 바로 띄운다 — macOS 알림 권한이 허용됐는지 확인하는 용도
    const testNotification = useCallback(() => {
        void window.electronAPI.showNotification({title: "Better Claude", body: "알림이 이렇게 표시됩니다."});
    }, []);

    return {...state, setSoundEnabled, setVolume, setOsEnabled, preview, testNotification} as const;
}
