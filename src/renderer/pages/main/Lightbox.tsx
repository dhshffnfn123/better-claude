import {type MouseEvent, type ReactNode, useCallback, useEffect, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {ImageViewerContext} from "../../tab-context";

const cx = classNames.bind(styles);

// 그림 크게 보기 — 답변(ChatTabView), 에이전트 패널, 파일 보기·지침 패널의 마크다운이 같이 쓴다.
// 바깥이나 ×를 누르거나 Esc로 닫는다. onClose는 바뀌지 않는 함수로 넘긴다(Esc 구독이 그때마다 다시 걸리지 않게).
export function Lightbox({src, onClose}: {src: string; onClose: () => void}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    const close = (e: MouseEvent) => {
        e.stopPropagation();
        onClose();
    };
    return (
        <div className={cx("lightboxOverlay")} onClick={close}>
            <button className={cx("lightboxClose")} onClick={close} aria-label="닫기">
                <FontAwesomeIcon icon={faXmark} />
            </button>
            <img
                src={src}
                className={cx("lightboxImage", {lightboxImageSvg: src.startsWith("data:image/svg+xml")})}
                alt=""
                onClick={(e) => e.stopPropagation()}
                // SVG는 그림 비율(--ar)대로 화면에 맞춰 키운다 — CSS만으로는 비율을 알 수 없다
                onLoad={(e) => {
                    const {naturalWidth: w, naturalHeight: h} = e.currentTarget;
                    if (w > 0 && h > 0) e.currentTarget.style.setProperty("--ar", String(w / h));
                }}
            />
        </div>
    );
}

// 탭 화면 밖의 마크다운(파일 보기, 지침 패널)도 그림을 누르면 크게 — 답변 쪽은 ChatTabView가 같은 일을 한다.
// 마크다운 상자(.bubble) 밖에 두고 쓴다.
export function ImageViewer({children}: {children: ReactNode}) {
    const [src, setSrc] = useState<string | null>(null);
    const close = useCallback(() => setSrc(null), []);
    return (
        <ImageViewerContext.Provider value={setSrc}>
            {children}
            {src && <Lightbox src={src} onClose={close} />}
        </ImageViewerContext.Provider>
    );
}
