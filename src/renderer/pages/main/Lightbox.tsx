import {type MouseEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faChevronLeft,
    faChevronRight,
    faCompress,
    faCopy,
    faExpand,
    faFolderOpen,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {ImageViewerContext, type OpenImage} from "../../tab-context";
import {MiddleName} from "./MiddleName";

const cx = classNames.bind(styles);

// 그림 크게 보기 — 답변(ChatTabView), 에이전트 패널, 파일 보기·지침 패널의 마크다운, 입력창의 첨부 그림이 같이 쓴다.
// 위쪽 줄: 이름·크기, 실제 크기 ↔ 화면에 맞추기, 그림 복사, Finder에서 보기, 닫기. 바깥이나 ×를 누르거나 Esc로 닫는다.
//
// 앞뒤 그림(‹ ›, ←/→) = 같은 화면(root) 안에서 누르면 크게 보기가 열리는 요소(data-zoomable)를 화면 순서대로 — 접힌 곳·
// 숨은 탭처럼 보이지 않는 것은 뺀다. 넘기기는 그 그림을 누르는 것과 같다(el.click()): 그림마다 원본을 가져오는 방법이
// 달라서(큰 그림은 썸네일 → main에서 원본, SVG는 그대로 …) 각자의 onClick을 그대로 쓴다. 원본이 오기 전에는 썸네일을
// 먼저 보인다. 이름과 위치는 그 요소의 data-zoom-name / data-zoom-path에서 읽는다.

const ZOOMABLE = "data-zoomable";

function zoomables(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>(`[${ZOOMABLE}]`)].filter((el) => el.getClientRects().length > 0);
}

// 넘기는 동안 먼저 보일 그림 — 그 요소의 썸네일
function previewOf(el: HTMLElement): string | null {
    const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
    return img?.src || null;
}

// 그림 복사 — 캔버스에 그려 PNG로 (SVG·WebP도 다른 앱에 붙여 넣을 수 있게). SVG는 크기 없이 300×150으로 잡히곤 해서
// 붙여 넣은 곳에서 흐리지 않게 키워서 그린다.
async function copyImage(src: string): Promise<boolean> {
    try {
        const img = new Image();
        img.src = src;
        await img.decode();
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (!w || !h) return false;
        if (src.startsWith("data:image/svg+xml")) {
            const k = Math.max(1, 1600 / Math.max(w, h));
            w = Math.round(w * k);
            h = Math.round(h * k);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        ctx.drawImage(img, 0, 0, w, h);
        return await window.electronAPI.writeClipboardImage(canvas.toDataURL("image/png"));
    } catch {
        return false;
    }
}

interface View {
    src: string;
    from: HTMLElement | null; // 누른 그림 요소 — 앞뒤 넘기기의 기준, 이름·위치
}

// 크게 보기 상태와 화면. open을 ImageViewerContext / onImageClick으로 넘기고 lightbox를 그린다.
// rootRef = 앞뒤로 넘길 그림들을 담은 요소 (탭의 메시지 목록, 패널 본문 …). tabId = Finder에서 보기에 쓴다.
export function useLightbox(rootRef: RefObject<HTMLElement | null>, tabId: string): {open: OpenImage; lightbox: ReactNode} {
    const [view, setView] = useState<View | null>(null);
    const shownRef = useRef(false);
    // 마지막으로 넘겨 간 그림 — 빨리 넘길 때 늦게 끝난 앞 그림의 원본이 지금 그림을 덮지 않게
    const wantRef = useRef<HTMLElement | null>(null);

    const open = useCallback<OpenImage>((src, from) => {
        if (shownRef.current && wantRef.current && from && from !== wantRef.current) return;
        shownRef.current = true;
        wantRef.current = from ?? null;
        setView({src, from: from ?? null});
    }, []);

    const close = useCallback(() => {
        shownRef.current = false;
        wantRef.current = null;
        setView(null);
    }, []);

    const show = useCallback((el: HTMLElement) => {
        wantRef.current = el;
        const preview = previewOf(el);
        if (preview) setView({src: preview, from: el});
        el.click();
    }, []);

    const lightbox = view ? (
        <Lightbox view={view} items={zoomables(rootRef.current)} tabId={tabId} onClose={close} onShow={show} />
    ) : null;
    return {open, lightbox};
}

interface Dims {
    src: string; // 어느 그림의 값인지 — 넘기면 저절로 무효
    w: number;
    h: number;
    shrunk: boolean; // 화면에 맞추느라 줄여서 보이는 중 — 실제 크기로 볼 수 있다
}

function Lightbox({
    view,
    items,
    tabId,
    onClose,
    onShow,
}: {
    view: View;
    items: HTMLElement[];
    tabId: string;
    onClose: () => void;
    onShow: (el: HTMLElement) => void;
}) {
    const index = view.from ? items.indexOf(view.from) : -1;
    const nav = index >= 0 && items.length > 1;
    const prev = nav && index > 0 ? items[index - 1] : null;
    const next = nav && index < items.length - 1 ? items[index + 1] : null;
    const name = view.from?.dataset.zoomName || null;
    const filePath = view.from?.dataset.zoomPath || null;
    const svg = view.src.startsWith("data:image/svg+xml");

    // 크기·실제 크기·복사 결과는 그림(src)마다 — 넘기면 저절로 화면에 맞춘 보기로 돌아간다. 효과(effect)로 지우면
    // 데이터 주소 그림은 그보다 먼저 다 불러와져서(onLoad) 잰 크기가 지워졌다.
    const [measured, setDims] = useState<Dims | null>(null);
    const [actualSrc, setActualSrc] = useState<string | null>(null);
    const [copiedFor, setCopied] = useState<{src: string; ok: boolean} | null>(null);
    const dims = measured?.src === view.src ? measured : null;
    const actual = actualSrc === view.src;
    const copied = copiedFor?.src === view.src ? copiedFor.ok : null;
    // 실제 크기로 바꿀 때 누른 자리가 그대로 손 아래 오게 (fx·fy = 그림 안 비율, cx·cy = 화면 위치)
    const focusRef = useRef<{fx: number; fy: number; cx: number; cy: number} | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{x: number; y: number; left: number; top: number; moved: boolean} | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                // 뒤에 있는 입력창의 커서가 움직이지 않게
                e.preventDefault();
                const el = e.key === "ArrowLeft" ? prev : next;
                if (el) onShow(el);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose, onShow, prev, next]);

    useLayoutEffect(() => {
        const box = scrollRef.current;
        const img = box?.querySelector("img");
        const f = focusRef.current;
        if (!actual || !box || !img || !dims) return;
        // 그림의 그 점(여백·가운데 맞춤 포함 offsetLeft/Top 기준)이 누른 화면 위치에 오게 (버튼으로 바꾸면 가운데)
        const r = box.getBoundingClientRect();
        box.scrollLeft = img.offsetLeft + (f?.fx ?? 0.5) * dims.w - ((f?.cx ?? r.left + r.width / 2) - r.left);
        box.scrollTop = img.offsetTop + (f?.fy ?? 0.5) * dims.h - ((f?.cy ?? r.top + r.height / 2) - r.top);
        focusRef.current = null;
    }, [actual, dims]);

    const zoomable = !svg && !!dims?.shrunk;
    const close = (e: MouseEvent) => {
        e.stopPropagation();
        onClose();
    };
    // 끝에서는 흐리게만 — 숨기면 그 자리를 누른 것이 바깥 클릭이 되어 창이 닫힌다
    const go = (el: HTMLElement | null) => (e: MouseEvent) => {
        e.stopPropagation();
        if (el) onShow(el);
    };
    const copy = () => {
        const src = view.src;
        void copyImage(src).then((ok) => {
            setCopied({src, ok});
            window.setTimeout(() => setCopied((c) => (c?.src === src ? null : c)), 1500);
        });
    };

    return (
        <div className={cx("lightboxOverlay", {lightboxHasNav: nav})} onClick={close}>
            <div className={cx("lightboxBar")} onClick={(e) => e.stopPropagation()}>
                <div className={cx("lightboxCaption")}>
                    {name && (
                        <span className={cx("lightboxName")} title={filePath ?? name}>
                            <MiddleName name={name} />
                        </span>
                    )}
                    {dims && (
                        <span className={cx("lightboxDims")}>
                            {dims.w.toLocaleString()} × {dims.h.toLocaleString()}
                            {zoomable && (actual ? " · 실제 크기" : " · 줄여서 보는 중")}
                        </span>
                    )}
                </div>
                {zoomable && (
                    <button
                        className={cx("lightboxBtn")}
                        onClick={() => setActualSrc(actual ? null : view.src)}
                        aria-label={actual ? "화면에 맞추기" : "실제 크기로 보기"}
                        data-tooltip={actual ? "화면에 맞추기" : "실제 크기로 보기 (그림을 눌러도 됩니다)"}
                        data-tooltip-dir="down"
                    >
                        <FontAwesomeIcon icon={actual ? faCompress : faExpand} />
                    </button>
                )}
                <button
                    className={cx("lightboxBtn")}
                    onClick={copy}
                    aria-label="그림 복사"
                    data-tooltip={copied === null ? "그림 복사" : copied ? "복사했습니다" : "복사하지 못했습니다"}
                    data-tooltip-dir="down"
                >
                    <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                </button>
                {filePath && tabId && (
                    <button
                        className={cx("lightboxBtn")}
                        onClick={() => void window.electronAPI.revealFile(tabId, filePath)}
                        aria-label="Finder에서 보기"
                        data-tooltip="Finder에서 보기"
                        data-tooltip-dir="down"
                    >
                        <FontAwesomeIcon icon={faFolderOpen} />
                    </button>
                )}
                <button className={cx("lightboxBtn")} onClick={close} aria-label="닫기" data-tooltip="닫기 (Esc)" data-tooltip-dir="down">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            {nav && (
                <>
                    <button
                        className={cx("lightboxNav", "lightboxPrev", {lightboxNavOff: !prev})}
                        onClick={go(prev)}
                        aria-label="이전 그림"
                        aria-disabled={!prev}
                        title="이전 그림 (←)"
                    >
                        <FontAwesomeIcon icon={faChevronLeft} />
                    </button>
                    <button
                        className={cx("lightboxNav", "lightboxNext", {lightboxNavOff: !next})}
                        onClick={go(next)}
                        aria-label="다음 그림"
                        aria-disabled={!next}
                        title="다음 그림 (→)"
                    >
                        <FontAwesomeIcon icon={faChevronRight} />
                    </button>
                    <span className={cx("lightboxCount")} onClick={(e) => e.stopPropagation()}>
                        {index + 1} / {items.length}
                    </span>
                </>
            )}
            {actual ? (
                // 실제 크기: 끌어서 옮기고(스크롤), 그냥 누르면 화면에 맞춘 보기로
                <div
                    ref={scrollRef}
                    className={cx("lightboxScroll")}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => {
                        const box = scrollRef.current;
                        if (!box || e.button !== 0) return;
                        box.setPointerCapture(e.pointerId);
                        dragRef.current = {x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false};
                    }}
                    onPointerMove={(e) => {
                        const d = dragRef.current;
                        const box = scrollRef.current;
                        if (!d || !box) return;
                        const dx = e.clientX - d.x;
                        const dy = e.clientY - d.y;
                        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
                        box.scrollLeft = d.left - dx;
                        box.scrollTop = d.top - dy;
                    }}
                    onPointerUp={() => {
                        const d = dragRef.current;
                        dragRef.current = null;
                        if (d && !d.moved) setActualSrc(null);
                    }}
                >
                    <img src={view.src} className={cx("lightboxImageActual")} alt="" draggable={false} />
                </div>
            ) : (
                <img
                    // 그림마다 새로 — SVG 비율(--ar)이 앞 그림에서 넘어오지 않게
                    key={view.src}
                    src={view.src}
                    className={cx("lightboxImage", {lightboxImageSvg: svg, lightboxImageZoomable: zoomable})}
                    alt=""
                    draggable={false}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (!zoomable) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        focusRef.current = {
                            fx: (e.clientX - r.left) / r.width,
                            fy: (e.clientY - r.top) / r.height,
                            cx: e.clientX,
                            cy: e.clientY,
                        };
                        setActualSrc(view.src);
                    }}
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        const {naturalWidth: w, naturalHeight: h} = img;
                        // SVG는 그림 비율(--ar)대로 화면에 맞춰 키운다 — CSS만으로는 비율을 알 수 없다
                        if (w > 0 && h > 0) img.style.setProperty("--ar", String(w / h));
                        setDims({src: view.src, w, h, shrunk: w > img.clientWidth + 1 || h > img.clientHeight + 1});
                    }}
                />
            )}
        </div>
    );
}

// 탭 화면 밖의 마크다운(파일 보기, 지침 패널, 받은 지시)도 그림을 누르면 크게 — 답변 쪽은 ChatTabView가 같은 일을 한다.
// 마크다운 상자(.bubble) 밖에 두고 쓴다. 감싸는 div는 상자를 만들지 않는다(display: contents) — 앞뒤 그림을 찾는 범위일 뿐.
export function ImageViewer({tabId, children}: {tabId: string; children: ReactNode}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const {open, lightbox} = useLightbox(rootRef, tabId);
    return (
        <ImageViewerContext.Provider value={open}>
            <div ref={rootRef} style={{display: "contents"}}>
                {children}
            </div>
            {lightbox}
        </ImageViewerContext.Provider>
    );
}
