import {type RefObject, useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCircleExclamation, faCircleNotch, faGears, faPlus, faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {Attention} from "../../hooks/useClaudeChat";

const cx = classNames.bind(styles);

export interface TabStripItem {
    id: string;
    title: string;
    folder: string; // 작업 폴더 이름 (경로 마지막 부분)
    cwd: string;
    isLoading: boolean;
    attention: Attention;
    unseen: boolean; // 다른 탭을 보는 사이 응답이 끝났다
    background: number; // 실행 중인 백그라운드 작업 수 (dev 서버 등)
}

interface Props {
    tabs: TabStripItem[];
    activeId: string;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
}

// 폴더 이름은 길면 가운데를 줄인다 — 끝 TAIL 글자는 늘 보이게 (파일 트리의 NameText와 같은 방식)
const TAIL = 4;
function FolderName({name}: {name: string}) {
    if (name.length <= TAIL + 3) return <span className={cx("tabFolder")}>{name}</span>;
    return (
        <span className={cx("tabFolder")}>
            <span className={cx("tabFolderHead")}>{name.slice(0, -TAIL)}</span>
            <span className={cx("tabFolderTail")}>{name.slice(-TAIL)}</span>
        </span>
    );
}

function statusLabel(t: TabStripItem): string {
    if (t.attention === "permission") return "허용을 기다리는 중";
    if (t.attention === "question") return "질문에 답을 기다리는 중";
    if (t.isLoading) return "응답 중";
    if (t.unseen) return "새 응답";
    return "";
}

// 가려진 탭이 왼쪽·오른쪽에 있는지
function measureEdges(el: HTMLElement): {left: boolean; right: boolean} {
    return {left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1};
}

// 탭이 넘쳐 옆으로 밀렸을 때: 마우스 휠(세로)로도 넘기고, 가려진 쪽 가장자리를 흐리게 해 더 있다는 걸 보인다.
// 스크롤바는 숨겨 두었다(탭 줄이 두꺼워진다). count가 바뀌면 다시 잰다 — 탭 줄이 이미 꽉 찼으면
// 탭이 늘어도 탭 줄 크기는 그대로라 ResizeObserver가 알려 주지 않는다.
function useOverflowScroll(ref: RefObject<HTMLDivElement>, count: number) {
    const [edges, setEdges] = useState({left: false, right: false});

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const update = () => {
            const next = measureEdges(el);
            setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
        };
        // 휠은 세로로 굴러도 가로로 넘긴다. 트랙패드 가로 밀기(deltaX)는 브라우저가 알아서 넘긴다.
        const onWheel = (e: WheelEvent) => {
            if (el.scrollWidth <= el.clientWidth) return;
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            // deltaMode 1 = 줄 단위(일부 마우스) — 픽셀로 바꾼다
            el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        };
        update();
        el.addEventListener("scroll", update, {passive: true});
        el.addEventListener("wheel", onWheel, {passive: true});
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => {
            el.removeEventListener("scroll", update);
            el.removeEventListener("wheel", onWheel);
            ro.disconnect();
        };
    }, [ref, count]);

    return edges;
}

// 헤더 아래 탭 줄 (크롬처럼). 탭이 많으면 줄어들고, 더 많으면 옆으로 넘긴다.
export function TabStrip({tabs, activeId, onSelect, onClose, onNew}: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const edges = useOverflowScroll(listRef, tabs.length);

    // 고른 탭이 줄 밖에 있으면 보이게 넘긴다 (⌘숫자·⌃Tab으로 옮겼을 때)
    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
        el?.scrollIntoView({block: "nearest", inline: "nearest"});
    }, [activeId]);

    return (
        <div className={cx("tabStrip")}>
            <div
                className={cx("tabList", {tabListFadeLeft: edges.left, tabListFadeRight: edges.right})}
                role="tablist"
                aria-label="대화 탭"
                ref={listRef}
            >
                {tabs.map((t) => {
                    const status = statusLabel(t);
                    return (
                        <div
                            key={t.id}
                            data-tab-id={t.id}
                            role="tab"
                            tabIndex={0}
                            aria-selected={t.id === activeId}
                            className={cx("tab", {tabActive: t.id === activeId})}
                            onClick={() => onSelect(t.id)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelect(t.id);
                                }
                            }}
                            // 가운데 버튼 클릭으로 닫기 (브라우저 탭처럼)
                            onMouseDown={(e) => {
                                if (e.button === 1) e.preventDefault();
                            }}
                            onAuxClick={(e) => {
                                if (e.button === 1) onClose(t.id);
                            }}
                            title={[t.title, t.cwd, status, t.background > 0 ? `백그라운드 작업 ${t.background}개 실행 중` : ""]
                                .filter(Boolean)
                                .join("\n")}
                        >
                            {t.attention ? (
                                <FontAwesomeIcon icon={faCircleExclamation} className={cx("tabAttention")} />
                            ) : t.isLoading ? (
                                <FontAwesomeIcon icon={faCircleNotch} spin className={cx("tabSpinner")} />
                            ) : t.unseen ? (
                                <span className={cx("tabUnseen")} />
                            ) : null}
                            {t.folder && <FolderName name={t.folder} />}
                            <span className={cx("tabTitle")}>{t.title}</span>
                            {/* 백그라운드 작업(dev 서버 등)이 도는 탭 — 다른 탭을 보고 있어도 보이게 */}
                            {t.background > 0 && (
                                <span className={cx("tabBg")} aria-label={`백그라운드 작업 ${t.background}개`}>
                                    <FontAwesomeIcon icon={faGears} />
                                    {t.background}
                                </span>
                            )}
                            <button
                                className={cx("tabClose")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose(t.id);
                                }}
                                aria-label="탭 닫기"
                                title="탭 닫기 (⌘W)"
                            >
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>
                    );
                })}
            </div>
            <button className={cx("tabNew")} onClick={onNew} data-tooltip="새 탭 (⌘T)" data-tooltip-dir="down" aria-label="새 탭">
                <FontAwesomeIcon icon={faPlus} />
            </button>
        </div>
    );
}
