import {type DragEvent, type RefObject, useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCircleExclamation, faCircleNotch, faPlus, faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {Attention} from "../../hooks/useClaudeChat";
import {isImeComposing} from "./ChatInput";

const cx = classNames.bind(styles);

export interface TabStripItem {
    id: string;
    title: string; // 보일 이름 — 붙인 이름이 있으면 그것, 없으면 자동 제목
    autoTitle: string; // 자동 제목 (첫 메시지 → 대화 요약)
    named: boolean; // 사용자가 이름을 붙였다
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
    onMove: (id: string, beforeId: string | null) => void; // 끌어 옮기기 — beforeId 앞으로 (null = 맨 끝)
    onRename: (id: string, name: string | null) => void; // 이름 붙이기 — null = 자동 제목으로
}

// 탭 이름 고치기 — 탭을 더블클릭하면 제목 자리가 입력칸이 된다. Enter·바깥 클릭 = 저장, Esc = 취소.
// 비우거나 자동 제목과 같게 두면 붙인 이름을 지우고 자동 제목으로 돌아간다.
function TabTitleEditor({initial, autoTitle, onDone}: {initial: string; autoTitle: string; onDone: (name?: string | null) => void}) {
    const [value, setValue] = useState(initial);
    const ref = useRef<HTMLInputElement>(null);
    const doneRef = useRef(false);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const finish = (save: boolean) => {
        if (doneRef.current) return;
        doneRef.current = true;
        if (!save) return onDone(undefined);
        const v = value.trim();
        onDone(v && v !== autoTitle ? v : null);
    };
    return (
        <input
            ref={ref}
            className={cx("tabTitleInput")}
            value={value}
            placeholder={autoTitle}
            maxLength={60}
            aria-label="탭 이름"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
                // 탭의 Enter·Space(고르기)로 올라가지 않게
                e.stopPropagation();
                if (isImeComposing(e)) return;
                if (e.key === "Enter") {
                    e.preventDefault();
                    finish(true);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    finish(false);
                }
            }}
            onBlur={() => finish(true)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        />
    );
}

// 탭을 끌 때 싣는 자료 종류 — 파일 끌어 놓기(탭 화면)와 섞이지 않게 따로
const TAB_DRAG_TYPE = "application/x-bc-tab";

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
export function TabStrip({tabs, activeId, onSelect, onClose, onNew, onMove, onRename}: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const edges = useOverflowScroll(listRef, tabs.length);
    // 끌어 옮기기: 끄는 탭, 놓일 자리(그 탭의 앞/뒤 — 세로 줄로 보인다)
    const [dragId, setDragId] = useState<string | null>(null);
    const [drop, setDrop] = useState<{id: string; after: boolean} | null>(null);
    // 이름을 고치는 중인 탭
    const [editingId, setEditingId] = useState<string | null>(null);
    const isTabDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(TAB_DRAG_TYPE);
    const endDrag = () => {
        setDragId(null);
        setDrop(null);
    };
    const dropTab = (e: DragEvent) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        const id = e.dataTransfer.getData(TAB_DRAG_TYPE);
        if (id && drop && drop.id !== id) {
            const at = tabs.findIndex((t) => t.id === drop.id);
            const beforeId = drop.after ? (tabs[at + 1]?.id ?? null) : drop.id;
            if (beforeId !== id) onMove(id, beforeId);
        }
        endDrag();
    };

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
                // 탭 사이가 아닌 빈 곳(마지막 탭 뒤)에 놓으면 맨 끝으로
                onDragOver={(e) => {
                    if (!isTabDrag(e) || e.target !== e.currentTarget || tabs.length === 0) return;
                    e.preventDefault();
                    setDrop({id: tabs[tabs.length - 1].id, after: true});
                }}
                onDrop={dropTab}
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
                            className={cx("tab", {
                                tabActive: t.id === activeId,
                                tabDragging: t.id === dragId,
                                tabDropBefore: drop?.id === t.id && !drop.after && dragId !== t.id,
                                tabDropAfter: drop?.id === t.id && drop.after && dragId !== t.id,
                            })}
                            onClick={() => onSelect(t.id)}
                            onDoubleClick={(e) => {
                                if ((e.target as HTMLElement).closest("button")) return;
                                onSelect(t.id);
                                setEditingId(t.id);
                            }}
                            // 이름을 고치는 동안은 끌지 않는다 (입력칸에서 글자를 고를 수 있게)
                            draggable={editingId !== t.id}
                            onDragStart={(e) => {
                                e.dataTransfer.setData(TAB_DRAG_TYPE, t.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDragId(t.id);
                            }}
                            onDragOver={(e) => {
                                if (!isTabDrag(e)) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                                const r = e.currentTarget.getBoundingClientRect();
                                const after = e.clientX > r.left + r.width / 2;
                                if (drop?.id !== t.id || drop.after !== after) setDrop({id: t.id, after});
                            }}
                            onDrop={(e) => {
                                e.stopPropagation();
                                dropTab(e);
                            }}
                            onDragEnd={endDrag}
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
                            title={
                                editingId === t.id
                                    ? undefined
                                    : [
                                          t.title,
                                          t.named ? `자동 제목: ${t.autoTitle}` : "",
                                          t.cwd,
                                          status,
                                          t.background > 0 ? `백그라운드 작업 ${t.background}개 실행 중` : "",
                                          "더블클릭해서 이름 바꾸기",
                                      ]
                                          .filter(Boolean)
                                          .join("\n")
                            }
                        >
                            {t.attention ? (
                                <FontAwesomeIcon icon={faCircleExclamation} className={cx("tabAttention")} />
                            ) : t.isLoading ? (
                                <FontAwesomeIcon icon={faCircleNotch} spin className={cx("tabSpinner")} />
                            ) : t.unseen ? (
                                <span className={cx("tabUnseen")} />
                            ) : null}
                            {t.folder && <FolderName name={t.folder} />}
                            {editingId === t.id ? (
                                <TabTitleEditor
                                    initial={t.title}
                                    autoTitle={t.autoTitle}
                                    onDone={(name) => {
                                        setEditingId(null);
                                        if (name !== undefined) onRename(t.id, name);
                                    }}
                                />
                            ) : (
                                <span className={cx("tabTitle", {tabTitleNamed: t.named})}>{t.title}</span>
                            )}
                            {/* 백그라운드 작업(dev 서버 등)이 도는 탭 — 다른 탭을 보고 있어도 보이게. 예전 회색 "⚙ 3"은
                                10px에 반투명이라 눈에 띄지 않았다 — 색 있는 알약 + 도는 표시 */}
                            {t.background > 0 && (
                                <span className={cx("tabBg")} aria-label={`백그라운드 작업 ${t.background}개`}>
                                    <span className={cx("tabBgSpin")} />
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
