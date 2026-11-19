import {type ReactNode, useEffect, useLayoutEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faChevronUp} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {EXPAND_EVENT} from "../../tab-context";

const cx = classNames.bind(styles);

// 긴 내용 접기 — 답변 속 긴 코드 블록, 붙여 넣은 긴 내 메시지가 대화를 한없이 늘어뜨렸다.
// 내용이 max의 1.3배보다 길면 max까지만 보이고 아래를 흐리게 한 뒤 "전체 보기"로 펼친다 (조금 넘는 것은 접지 않는다).
// 높이는 그린 뒤에 잰다(ResizeObserver) — 줄 수로만 정하면 줄바꿈 없는 긴 한 줄(로그·JSON)이 걸리지 않는다.
// 숨은 탭(display: none)에서는 높이가 0이라 접지 않다가 보이게 되면 다시 잰다. 받는 중에 길어지는 코드도 그때 접힌다.
// ⌘F 찾기가 접힌 곳에서 찾으면 EXPAND_EVENT로 펼친다(FindBar) — 그래서 data-collapsed를 단다.

export function Collapsible({
    max,
    label,
    toggleClassName,
    children,
}: {
    max: number;
    label: string; // 접혀 있을 때 버튼 글 (예: "전체 보기 · 120줄")
    toggleClassName?: string;
    children: ReactNode;
}) {
    const boxRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const [tall, setTall] = useState(false);
    const [open, setOpen] = useState(false);

    useLayoutEffect(() => {
        const inner = innerRef.current;
        if (!inner) return;
        const check = () => {
            const h = inner.offsetHeight;
            if (h > 0) setTall(h > max * 1.3);
        };
        check();
        const ro = new ResizeObserver(check);
        ro.observe(inner);
        return () => ro.disconnect();
    }, [max]);

    useEffect(() => {
        const box = boxRef.current;
        if (!box) return;
        // 찾기(FindBar)는 펼친 뒤 다시 그려지기를 기다렸다가 자리를 잰다
        const onExpand = () => setOpen(true);
        box.addEventListener(EXPAND_EVENT, onExpand);
        return () => box.removeEventListener(EXPAND_EVENT, onExpand);
    }, []);

    const collapsed = tall && !open;
    const toggle = () => {
        const closing = open;
        setOpen(!open);
        // 다 읽고 맨 아래에서 접으면 그만큼 내용이 줄어 엉뚱한 곳에 남는다 — 접은 블록이 보이게
        if (closing) requestAnimationFrame(() => boxRef.current?.scrollIntoView({block: "nearest"}));
    };
    return (
        <>
            <div
                ref={boxRef}
                className={cx({collapseBoxClosed: collapsed})}
                style={collapsed ? {maxHeight: max} : undefined}
                data-collapsed={collapsed ? "" : undefined}
            >
                <div ref={innerRef}>{children}</div>
            </div>
            {tall && (
                <button className={cx("collapseToggle", toggleClassName)} onClick={toggle} aria-expanded={open}>
                    <FontAwesomeIcon icon={open ? faChevronUp : faChevronDown} />
                    {open ? "접기" : label}
                </button>
            )}
        </>
    );
}
