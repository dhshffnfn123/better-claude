import {BrowserWindow, session} from "electron";

// 화면 대조(F5)의 "구현" 쪽 — 이 컴퓨터에서 도는 웹 페이지(dev 서버 등)를 숨은 창에서 열어 찍는다.
// 이 컴퓨터 주소(localhost·127.0.0.1·[::1]·*.localhost)만 연다. 창은 보이지 않고(show: false), 앱 화면과 떨어진 메모리 세션
// (디스크에 쿠키·저장소를 남기지 않는다)에 sandbox·contextIsolation·preload 없음 — 보통 브라우저 탭과 같은 권한이다.
// 주 프레임이 이 컴퓨터 밖으로 넘어가는 이동·새 창·다운로드·권한 요청(카메라 등)은 막는다. 그림·글꼴 같은 하위 요청은
// 그대로 둔다(실제 화면과 같게 — 웹 글꼴·CDN을 쓰는 페이지가 많다). 찍고 나면 창을 닫는다.

const PARTITION = "bc-screen-capture"; // persist: 없이 → 메모리에만
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 700; // 글꼴·첫 렌더가 끝나고 조금 더 — 화면이 자리 잡을 시간
const FONT_WAIT_MS = 4000;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 4000;
const MAX_FULL_HEIGHT = 12_000;

export interface ScreenCaptureRequest {
    url: string;
    width: number;
    height: number;
    fullPage?: boolean;
    colorScheme?: "light" | "dark";
}

export type ScreenCaptureResult =
    | {ok: true; dataUrl: string; url: string; title: string; width: number; height: number; pixelWidth: number; pixelHeight: number; at: number}
    | {ok: false; error: string};

export function isLoopbackUrl(raw: string): boolean {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

let captureSes: Electron.Session | null = null;

function captureSession(): Electron.Session {
    if (captureSes) return captureSes;
    const ses = session.fromPartition(PARTITION, {cache: false});
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (e) => e.preventDefault());
    // 주 프레임 이동은 이 컴퓨터 주소만 — 페이지가 location을 바꿔 외부 사이트로 가도 열지 않는다
    ses.webRequest.onBeforeRequest({urls: ["http://*/*", "https://*/*"], types: ["mainFrame"]}, (details, callback) => {
        callback(isLoopbackUrl(details.url) ? {} : {cancel: true});
    });
    captureSes = ses;
    return ses;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failText(e: unknown): string {
    const msg = (e as Error)?.message ?? String(e);
    if (/ERR_CONNECTION_REFUSED/.test(msg)) return "페이지를 열지 못했습니다 — 그 주소에서 서버가 돌고 있는지 확인하세요 (연결 거부)";
    if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(msg)) return "페이지를 열지 못했습니다 — 주소를 확인하세요";
    if (/ERR_CERT/.test(msg)) return "페이지를 열지 못했습니다 — 인증서 오류";
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(msg)) return "이 컴퓨터 밖 주소로 넘어가려 해서 멈췄습니다";
    return `페이지를 열지 못했습니다: ${msg}`;
}

export async function captureScreen(req: ScreenCaptureRequest): Promise<ScreenCaptureResult> {
    const url = typeof req?.url === "string" ? req.url.trim() : "";
    if (!isLoopbackUrl(url)) return {ok: false, error: "이 컴퓨터의 주소(localhost · 127.0.0.1)만 찍을 수 있습니다"};
    const width = Math.round(clamp(req.width, 240, MAX_WIDTH));
    const height = Math.round(clamp(req.height, 240, MAX_HEIGHT));

    const win = new BrowserWindow({
        show: false,
        width,
        height,
        useContentSize: true,
        enableLargerThanScreen: true,
        paintWhenInitiallyHidden: true,
        webPreferences: {
            session: captureSession(),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            spellcheck: false,
            devTools: false,
        },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({action: "deny"}));
    wc.on("will-navigate", (e, next) => {
        if (!isLoopbackUrl(next)) e.preventDefault();
    });
    wc.on("will-redirect", (e, next) => {
        if (!isLoopbackUrl(next)) e.preventDefault();
    });
    // 이 컴퓨터의 https dev 서버는 대개 자체 서명 인증서다 — 그 주소만 받아 준다
    wc.on("certificate-error", (e, certUrl, _error, _cert, callback) => {
        e.preventDefault();
        callback(isLoopbackUrl(certUrl));
    });
    wc.on("login", (e, _details, _auth, callback) => {
        e.preventDefault();
        callback();
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        const work = (async (): Promise<ScreenCaptureResult> => {
            // 앱이 어두운 화면이어도 찍는 페이지는 고른 화면 모드로 (prefers-color-scheme) — 디자인은 대개 밝은 화면이다.
            // 빈 문서를 먼저 열어야 한다: 아무 문서도 없는 창에 보낸 명령은 답이 오지 않았다(실측). 한 번 정하면 이동해도 남는다.
            await win.loadURL("about:blank");
            try {
                wc.debugger.attach("1.3");
                await Promise.race([
                    wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
                        features: [{name: "prefers-color-scheme", value: req.colorScheme === "dark" ? "dark" : "light"}],
                    }),
                    sleep(2000),
                ]);
            } catch (e) {
                console.error("[capture] 화면 모드를 정하지 못했습니다", e);
            }
            await win.loadURL(url);
            await Promise.race([
                wc.executeJavaScript("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 1) : 1"),
                sleep(FONT_WAIT_MS),
            ]);
            await sleep(SETTLE_MS);
            let shotHeight = height;
            if (req.fullPage) {
                const full = Number(
                    await wc.executeJavaScript(
                        "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"
                    )
                );
                shotHeight = Math.round(clamp(full, height, MAX_FULL_HEIGHT));
                if (shotHeight !== height) {
                    win.setContentSize(width, shotHeight);
                    await sleep(450);
                }
            }
            const img = await wc.capturePage(undefined, {stayHidden: true});
            if (img.isEmpty()) return {ok: false, error: "화면을 찍지 못했습니다 (빈 그림)"};
            const size = img.getSize();
            return {
                ok: true,
                dataUrl: img.toDataURL(),
                url: wc.getURL() || url,
                title: wc.getTitle(),
                width,
                height: shotHeight,
                pixelWidth: size.width,
                pixelHeight: size.height,
                at: Date.now(),
            };
        })();
        // 시간이 다 돼 창을 닫으면 아직 기다리던 일이 늦게 실패한다 — 그 실패는 버린다
        work.catch(() => undefined);
        const timeout = new Promise<ScreenCaptureResult>((resolve) => {
            timer = setTimeout(() => resolve({ok: false, error: "페이지가 20초 안에 열리지 않았습니다"}), LOAD_TIMEOUT_MS);
        });
        return await Promise.race([work, timeout]);
    } catch (e) {
        return {ok: false, error: failText(e)};
    } finally {
        if (timer) clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
    }
}
