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

// 슬라이더 값 → 소리 배율. 귀는 소리 세기를 로그로 느껴서, 배율을 값에 정비례로 두면(예전)
// 50→100이 +6 dB, 50→25가 −6 dB뿐이라 끝까지 밀어도 차이가 미세했다.
// 제곱으로 두면 느끼는 크기가 값에 거의 비례한다: 50 = 1배(예전 기본 크기 그대로), 100 = 4배(+12 dB),
// 25 = ¼(−12 dB), 10 = 1/25(−28 dB). 100에서도 두 음이 겹치는 순간까지 진폭이 1 아래라 찢어지지 않는다.
export function volumeGain(v: number): number {
    const x = v / DEFAULT_VOLUME;
    return x * x;
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

// 음 하나 = [시작(초), 주파수(Hz), 세기]
type Note = [number, number, number];

// 응답 완료 — A5 → E6로 살짝 올라가는 짧은 차임.
export const COMPLETION_NOTES: Note[] = [
    [0, 880, 0.16],
    [0.1, 1318.5, 0.13],
];
// Claude가 허용·답을 기다린다 — 완료음과 구분되게 E6 → B5로 내려간다.
export const ATTENTION_NOTES: Note[] = [
    [0, 1318.5, 0.14],
    [0.12, 987.8, 0.13],
];

// 배음 = [배수, 세기 비율, 꼭대기에서 0.0001까지 줄어드는 시간(초)].
// 기본(50% 이하): 사인파 하나는 얄팍해서 한 옥타브 위 배음을 작게 얹은 종소리 — 예전 소리 그대로.
const QUIET_PARTIALS: [number, number, number][] = [
    [1, 1, 0.372],
    [2, 0.28, 0.372],
    [3, 0, 0.25],
];
// 100%: 맥 음량을 작게 둬도 알림만 잘 들리게, 같은 최대 진폭 안에서 더 크게 들리는 모양.
// 더 길게 울리고(귀는 짧은 소리를 작게 느낀다), 꼭대기에서 잠깐 머물고, 귀가 가장 예민한
// 2~4 kHz에 3배 배음을 섞는다(첫머리가 또렷해진다). 길이·머묾·배음 후보를 오프라인으로 그려 비교해서 골랐다.
const LOUD_PARTIALS: [number, number, number][] = [
    [1, 1, 0.7],
    [2, 0.32, 0.5],
    [3, 0.2, 0.25],
];
const LOUD_HOLD = 0.04;
const ATTACK = 0.008;

// 음량 → 소리 모양. 50%를 넘으면 기본 모양에서 100% 모양으로 조금씩 바뀐다.
export function chimeShape(v: number): {partials: [number, number, number][]; hold: number; gain: number} {
    const loud = Math.min(1, Math.max(0, (v - DEFAULT_VOLUME) / DEFAULT_VOLUME));
    const mix = (a: number, b: number) => a + (b - a) * loud;
    return {
        partials: QUIET_PARTIALS.map(([ratio, share, decay], i): [number, number, number] => [
            ratio,
            mix(share, LOUD_PARTIALS[i][1]),
            mix(decay, LOUD_PARTIALS[i][2]),
        ]),
        hold: LOUD_HOLD * loud,
        gain: volumeGain(v),
    };
}

// 음들을 컨텍스트에 그린다 — 실제 재생과 오프라인 측정(OfflineAudioContext)이 같은 코드를 쓴다.
export function scheduleNotes(ac: BaseAudioContext, start: number, notes: Note[], v: number, out: AudioNode = ac.destination): void {
    const shape = chimeShape(v);
    for (const [delay, freq, peak] of notes) {
        const at = start + delay;
        for (const [ratio, share, decay] of shape.partials) {
            if (share <= 0) continue;
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            osc.type = "sine";
            osc.frequency.value = freq * ratio;
            const top = peak * shape.gain * share;
            const end = at + ATTACK + shape.hold + decay;
            // 0에서 시작하지 않으면 딱 하는 클릭음이 난다. 감쇠는 지수로 — 0은 못 넣으므로 0.0001.
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime(top, at + ATTACK);
            if (shape.hold > 0) gain.gain.setValueAtTime(top, at + ATTACK + shape.hold);
            gain.gain.exponentialRampToValueAtTime(0.0001, end);
            osc.connect(gain).connect(out);
            osc.start(at);
            osc.stop(end + 0.02);
        }
    }
}

// 두 음을 이어 친다. 음량 50%가 예전 크기 (배율은 volumeGain, 50% 위는 소리 모양도 바뀐다 — chimeShape).
function playNotes(notes: Note[]): void {
    if (volume <= 0) return;
    const ac = getContext();
    if (!ac) return;
    scheduleNotes(ac, ac.currentTime, notes, volume);
}

function completionNotes(): void {
    playNotes(COMPLETION_NOTES);
}

export function playCompletionSound(): void {
    if (enabled) completionNotes();
}

function playAttentionSound(): void {
    if (enabled) playNotes(ATTENTION_NOTES);
}

// 창이 앞에 있고 포커스가 있으면 사용자가 보고 있는 것으로 본다
function isAway(): boolean {
    return !document.hasFocus();
}

// tabId가 있으면 알림을 눌렀을 때 그 탭으로 간다
function showOsNotification(title: string, body: string, tabId?: string): void {
    if (osEnabled) void window.electronAPI.showNotification({title, body, tabId});
}

// 응답이 끝났다: 소리는 늘(예전과 같다), macOS 알림은 앱을 보고 있지 않을 때만.
export function notifyTurnDone(title: string, body: string, tabId?: string): void {
    playCompletionSound();
    if (isAway()) showOsNotification(title, body, tabId);
}

// 허용 요청·질문: 그 탭을 보고 있으면 화면의 창으로 충분하다. 앱을 보고 있지 않거나(소리 + macOS 알림)
// 다른 탭을 보고 있으면(소리 — 그 탭의 창은 지금 안 보인다) 알린다.
export function notifyNeedsInput(title: string, body: string, otherTab = false, tabId?: string): void {
    const away = isAway();
    if (!away && !otherTab) return;
    playAttentionSound();
    if (away) showOsNotification(title, body, tabId);
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
