import {useContext, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCircleHalfStroke,
    faCircleNotch,
    faEye,
    faGlobe,
    faRotateRight,
    faUpRightAndDownLeftFromCenter,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {ToolActivity} from "../../hooks/useClaudeChat";
import {ImageViewerContext, PreviewOpenContext, type PreviewRequest} from "../../tab-context";
import {FILES_PANEL_MIN_WIDTH} from "./files-panel-prefs";
import {MiddleName} from "./MiddleName";

const cx = classNames.bind(styles);

// HTML 미리보기 — 답변 속 HTML·SVG 코드 블록을 그려진 모습으로, Claude가 만든 .html 파일도 같은 방식으로 보여 준다.
// HTML은 main이 내주는 bc-preview:// 주소를 sandbox="allow-scripts" iframe으로 띄운다(앱과 출처가 달라 앱 화면과
// window.electronAPI에 닿지 못한다). SVG는 <img>로 그린다 — 그림 태그 안에서는 스크립트가 돌지 않는다.

export type PreviewKind = "html" | "svg";

// 미리 그릴 수 있는 코드 블록인가: html·svg, 언어 이름이 없어도 <svg·<!doctype html로 시작하면
export function previewKindOf(lang: string | undefined, code: string): PreviewKind | null {
    // 빈 블록은 그릴 게 없다 (예전에는 "너무 커서 미리 볼 수 없습니다"가 떴다)
    if (!code.trim()) return null;
    const l = (lang ?? "").toLowerCase();
    const head = code.trimStart().slice(0, 300).toLowerCase();
    const svg = /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head);
    if (l === "svg" || ((l === "xml" || l === "") && svg)) return "svg";
    if (l === "html" || l === "htm") return "html";
    if (l === "" && /^(<!doctype html|<html[\s>])/.test(head)) return "html";
    return null;
}

// 배경: 밝게 / 어둡게 / 체크무늬(투명한 부분이 보이게 — 아이콘 확인용)
export type PreviewBg = "light" | "dark" | "check";
const BG_ORDER: PreviewBg[] = ["light", "dark", "check"];
const BG_LABEL: Record<PreviewBg, string> = {light: "밝은 배경", dark: "어두운 배경", check: "체크무늬 배경"};

export function BgToggle({bg, onChange, className}: {bg: PreviewBg; onChange: (bg: PreviewBg) => void; className: string}) {
    const next = BG_ORDER[(BG_ORDER.indexOf(bg) + 1) % BG_ORDER.length];
    return (
        <button className={className} onClick={() => onChange(next)} title={`${BG_LABEL[bg]} — 눌러서 ${BG_LABEL[next]}`}>
            <FontAwesomeIcon icon={faCircleHalfStroke} />
        </button>
    );
}

// 답변 안에 그릴 때의 높이 — 내용 높이에 맞추되(미리보기 쪽이 postMessage로 알려 준다) 이 범위 안에서
const INLINE_DEFAULT_H = 240;
const INLINE_MIN_H = 48;
const INLINE_MAX_H = 560;

// 받는 중인 블록을 미리 볼 때 다시 그리는 간격 — 글이 바뀔 때마다(50ms) 새로 불러오면 깜빡이고 스크립트가 계속 다시 돈다
const LIVE_REFRESH_MS = 1000;

// 코드 블록 글 → 미리보기 주소. 같은 글이면 main이 같은 주소를 준다(iframe이 다시 불러오지 않는다).
// 받는 중(live)이면 LIVE_REFRESH_MS에 한 번만, 그때까지 쌓인 마지막 글로 바꾼다.
function useHtmlSrc(html: string | null, live: boolean): {src: string | null; tooBig: boolean} {
    const [state, setState] = useState<{src: string | null; tooBig: boolean}>({src: null, tooBig: false});
    const lastRef = useRef(0);
    useEffect(() => {
        if (html === null) return;
        let alive = true;
        const run = () => {
            lastRef.current = Date.now();
            window.electronAPI
                .registerHtmlPreview(html)
                .then((src) => {
                    if (alive) setState({src, tooBig: !src});
                })
                .catch(() => undefined);
        };
        const wait = live ? LIVE_REFRESH_MS - (Date.now() - lastRef.current) : 0;
        if (wait <= 0) {
            run();
            return () => {
                alive = false;
            };
        }
        const timer = setTimeout(run, wait);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [html, live]);
    return state;
}

// 미리보기를 품은 스크롤 상자(대화 목록 등). IntersectionObserver의 rootMargin은 화면(기본 root)에만 붙고, 그 안의
// 스크롤 상자 밖으로 나간 부분은 먼저 잘려서 600px 여유가 없었다 — 조금만 스크롤해도 미리보기가 사라졌다.
function scrollParentOf(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === "auto" || oy === "scroll") return p;
    }
    return null;
}

// 미리보기 틀. inline이면 화면 근처에 왔을 때만 iframe을 만든다 — 미리보기 하나가 문서 하나라서, 긴 대화·숨긴 탭에
// 다 띄워 두면 무겁다(숨긴 탭은 화면에 없으니 빠진다). 높이는 기억해 두어 다시 그릴 때 화면이 튀지 않는다.
export function PreviewFrame({src, bg, inline}: {src: string; bg: PreviewBg; inline: boolean}) {
    const boxRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const [near, setNear] = useState(!inline);
    const [height, setHeight] = useState(INLINE_DEFAULT_H);

    useEffect(() => {
        const el = boxRef.current;
        if (!inline || !el) return;
        const io = new IntersectionObserver((list) => setNear(list[list.length - 1].isIntersecting), {
            root: scrollParentOf(el),
            rootMargin: "600px 0px",
        });
        io.observe(el);
        return () => io.disconnect();
    }, [inline]);

    useEffect(() => {
        if (!inline) return;
        const onMessage = (e: MessageEvent) => {
            if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
            const h = (e.data as {bcPreviewHeight?: unknown} | null)?.bcPreviewHeight;
            if (typeof h === "number" && Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(Math.ceil(h), INLINE_MIN_H), INLINE_MAX_H));
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [inline]);

    return (
        <div ref={boxRef} className={cx("previewBox", `previewBg-${bg}`, {previewBoxInline: inline})} style={inline ? {height} : undefined}>
            {near && <iframe ref={frameRef} className={cx("previewFrame")} src={src} sandbox="allow-scripts" title="HTML 미리보기" />}
        </div>
    );
}

// <img>로 그리는 SVG는 따로 선 XML 문서라 xmlns가 있어야 그려진다 — HTML 속에 넣는 SVG는 흔히 xmlns 없이 쓴다
function svgDocument(code: string): string {
    return code.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
        let a = attrs;
        if (!/\sxmlns\s*=/.test(a)) a = ` xmlns="http://www.w3.org/2000/svg"` + a;
        if (/\bxlink:/.test(code) && !/\sxmlns:xlink\s*=/.test(a)) a = ` xmlns:xlink="http://www.w3.org/1999/xlink"` + a;
        return `<svg${a}>`;
    });
}

export function SvgPreview({code, bg, large = false}: {code: string; bg: PreviewBg; large?: boolean}) {
    const src = useMemo(() => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgDocument(code)), [code]);
    // XML로 읽을 수 없는 SVG(HTML 전용 문자 &nbsp; 등)는 깨진 그림 대신 안내를 보인다
    const [broken, setBroken] = useState<string | null>(null);
    // 답변 안에서는 줄여 보이므로 누르면 확대 창에 크게 (오른쪽 패널에 크게 띄운 것은 그대로)
    const openImage = useContext(ImageViewerContext);
    if (broken === src) return <div className={cx("previewNotice")}>그림으로 그릴 수 없는 SVG입니다 — 코드로 보세요</div>;
    return (
        <div className={cx("previewBox", "previewSvgBox", `previewBg-${bg}`, {previewSvgLarge: large})}>
            <img
                src={src}
                alt="SVG 미리보기"
                className={cx("previewSvg")}
                onError={() => setBroken(src)}
                data-zoomable={large || !openImage ? undefined : ""}
                data-zoom-name="SVG 미리보기"
                onClick={large || !openImage ? undefined : (e) => openImage(src, e.currentTarget)}
                title={large || !openImage ? undefined : "눌러서 크게 보기"}
            />
        </div>
    );
}

// 코드 블록의 미리보기 몸통
export function CodePreview({kind, code, bg, live}: {kind: PreviewKind; code: string; bg: PreviewBg; live: boolean}) {
    const {src, tooBig} = useHtmlSrc(kind === "html" ? code : null, live);
    if (kind === "svg") return <SvgPreview code={code} bg={bg} />;
    if (tooBig) return <div className={cx("previewNotice")}>너무 커서 미리 볼 수 없습니다 — 코드로 보세요</div>;
    if (!src) return <div className={cx("previewBox", `previewBg-${bg}`, "previewBoxInline")} style={{height: INLINE_DEFAULT_H}} />;
    return <PreviewFrame src={src} bg={bg} inline />;
}

// "크게 보기" 버튼 — 오른쪽 패널에 연다(패널은 셸이 그린다). 패널을 열 수 없는 곳(에이전트 기록 등)에서는 숨긴다.
export function OpenLargeButton({req, className}: {req: PreviewRequest; className: string}) {
    const open = useContext(PreviewOpenContext);
    if (!open) return null;
    return (
        <button className={className} onClick={() => open(req)} title="오른쪽 패널에 크게 보기">
            <FontAwesomeIcon icon={faUpRightAndDownLeftFromCenter} />
        </button>
    );
}

// ── Claude가 만든 .html 파일: 그 도구 줄 아래 카드 ──
const HTML_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export function htmlFileOf(tool: ToolActivity): string | null {
    if (tool.status !== "done" || !HTML_WRITE_TOOLS.has(tool.name)) return null;
    const p = (tool.input as {file_path?: unknown} | undefined)?.file_path;
    return typeof p === "string" && /\.html?$/i.test(p) ? p : null;
}

export function HtmlFileCard({path}: {path: string}) {
    const open = useContext(PreviewOpenContext);
    if (!open) return null;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (
        <button className={cx("htmlFileCard")} onClick={() => open({title: name, file: path})} title={`${path} — 오른쪽 패널에서 미리보기`}>
            <FontAwesomeIcon icon={faGlobe} className={cx("htmlFileCardIcon")} />
            <span className={cx("htmlFileCardName")}>
                <MiddleName name={name} />
            </span>
            <span className={cx("htmlFileCardAction")}>
                <FontAwesomeIcon icon={faEye} /> 미리보기
            </span>
        </button>
    );
}

// ── 오른쪽 패널(작업 파일 패널 자리): 크게 보기 ──
interface PanelProps {
    tabId: string;
    req: PreviewRequest;
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
}

export function PreviewPanel({tabId, req, width, onResize, onClose}: PanelProps) {
    const [bg, setBg] = useState<PreviewBg>(req.svg !== undefined ? "check" : "light");
    const [src, setSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // 다시 불러오기 — 파일은 main에 다시 물어(고친 뒤면 새 주소), 코드 블록은 iframe을 새로 만든다
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
        let alive = true;
        setError(null);
        if (req.html !== undefined) {
            void window.electronAPI.registerHtmlPreview(req.html).then((s) => {
                if (!alive) return;
                if (s) setSrc(s);
                else setError("너무 커서 미리 볼 수 없습니다");
            });
        } else if (req.file !== undefined) {
            void window.electronAPI.previewFile(tabId, req.file).then((r) => {
                if (!alive) return;
                if (r.ok === true) setSrc(r.src);
                else setError(r.error);
            });
        }
        return () => {
            alive = false;
        };
    }, [tabId, req, nonce]);

    // 왼쪽 가장자리를 끌어 너비 조절 — 작업 파일 패널과 같은 너비를 쓴다
    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const move = (ev: PointerEvent) =>
            onResize(Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, FILES_PANEL_MIN_WIDTH), window.innerWidth * 0.7)));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    return (
        <aside className={cx("filesPanel")} style={{width}}>
            <div className={cx("filesResize")} onPointerDown={startResize} title="끌어서 너비 조절" />
            <div className={cx("filesHeader")}>
                <span className={cx("filesTitle", "filesTitleRow")}>
                    <FontAwesomeIcon icon={faEye} className={cx("previewTitleIcon")} />
                    <span>미리보기 ·</span>
                    <MiddleName name={req.title} />
                </span>
                <BgToggle bg={bg} onChange={setBg} className={cx("filesHeaderBtn")} />
                {req.svg === undefined && (
                    <button className={cx("filesHeaderBtn")} onClick={() => setNonce((n) => n + 1)} title="다시 불러오기">
                        <FontAwesomeIcon icon={faRotateRight} />
                    </button>
                )}
                <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            <div className={cx("previewPanelBody")}>
                {req.svg !== undefined ? (
                    <SvgPreview code={req.svg} bg={bg} large />
                ) : error ? (
                    <div className={cx("viewerNotice")}>{error}</div>
                ) : src ? (
                    <PreviewFrame key={`${src}#${nonce}`} src={src} bg={bg} inline={false} />
                ) : (
                    <div className={cx("viewerNotice")}>
                        <FontAwesomeIcon icon={faCircleNotch} spin /> 불러오는 중…
                    </div>
                )}
            </div>
        </aside>
    );
}
