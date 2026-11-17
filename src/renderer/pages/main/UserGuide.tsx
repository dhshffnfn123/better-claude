import {Fragment, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import type {IconDefinition} from "@fortawesome/fontawesome-svg-core";
import {
    faBars,
    faBolt,
    faChartSimple,
    faBookOpen,
    faCircleHalfStroke,
    faCircleInfo,
    faClockRotateLeft,
    faCodeBranch,
    faComments,
    faCopy,
    faEye,
    faFolderTree,
    faLayerGroup,
    faMagnifyingGlass,
    faPaperclip,
    faPen,
    faRotateLeft,
    faRotateRight,
    faShield,
    faSliders,
    faTableColumns,
    faTerminal,
    faVolumeHigh,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {isImeComposing} from "./ChatInput";
import {GUIDE, type GuideItem} from "./user-guide";

const cx = classNames.bind(styles);

// 사용 가이드 — 사이드바 "사용 가이드"로 연다. 왼쪽 목차, 오른쪽 설명, 위쪽 찾기. 내용은 user-guide.ts.
// 탭 화면 위에 덮어 열 뿐이라 대화·응답은 그대로 이어진다.

// 글 속 {i:이름} → 앱 화면에 있는 그 아이콘 (버튼을 찾기 쉽게)
const ICONS: Record<string, IconDefinition> = {
    basics: faCircleInfo,
    chat: faComments,
    rewind: faRotateLeft,
    view: faEye,
    panels: faTableColumns,
    history: faClockRotateLeft,
    settings: faSliders,
    shield: faShield,
    bolt: faBolt,
    layers: faLayerGroup,
    files: faFolderTree,
    volume: faVolumeHigh,
    theme: faCircleHalfStroke,
    bars: faBars,
    paperclip: faPaperclip,
    terminal: faTerminal,
    book: faBookOpen,
    rotate: faRotateLeft,
    branch: faCodeBranch,
    copy: faCopy,
    retry: faRotateRight,
    pen: faPen,
    chart: faChartSimple,
};

// [[키]] → 키 모양, {i:이름} → 아이콘, `코드` → 코드 글씨
const TOKEN = /(\[\[[^\]]+\]\]|\{i:[a-z0-9]+\}|`[^`]+`)/g;

function Rich({text}: {text: string}) {
    const parts = text.split(TOKEN);
    return (
        <>
            {parts.map((p, i) => {
                if (p.startsWith("[[") && p.endsWith("]]")) {
                    return (
                        <kbd key={i} className={cx("guideKey")}>
                            {p.slice(2, -2)}
                        </kbd>
                    );
                }
                const icon = /^\{i:([a-z0-9]+)\}$/.exec(p);
                if (icon) {
                    const def = ICONS[icon[1]];
                    return def ? <FontAwesomeIcon key={i} icon={def} className={cx("guideInlineIcon")} /> : null;
                }
                if (p.startsWith("`") && p.endsWith("`") && p.length > 1) {
                    return (
                        <code key={i} className={cx("guideCode")}>
                            {p.slice(1, -1)}
                        </code>
                    );
                }
                return <Fragment key={i}>{p}</Fragment>;
            })}
        </>
    );
}

// 찾기에 쓰는 글 — 표시용 기호는 빼고
function plainText(item: GuideItem): string {
    return [item.title, item.body, ...(item.how ?? [])]
        .join(" ")
        .replace(/\[\[|\]\]|`/g, "")
        .replace(/\{i:[a-z0-9]+\}/g, "")
        .toLowerCase();
}

export function UserGuide({onClose}: {onClose: () => void}) {
    const [query, setQuery] = useState("");
    const [activeId, setActiveId] = useState(GUIDE[0].id);
    const bodyRef = useRef<HTMLDivElement>(null);
    const sectionRefs = useRef(new Map<string, HTMLElement>());

    const q = query.trim().toLowerCase();
    const sections = useMemo(
        () =>
            q
                ? GUIDE.map((s) => ({...s, items: s.items.filter((it) => plainText(it).includes(q))})).filter((s) => s.items.length > 0)
                : GUIDE,
        [q]
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !e.isComposing) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    // 찾는 글이 바뀌면 맨 위부터
    const firstId = sections[0]?.id;
    useEffect(() => {
        bodyRef.current?.scrollTo({top: 0});
        if (firstId) setActiveId(firstId);
    }, [q, firstId]);

    // 스크롤하는 동안 지금 보고 있는 부분을 목차에 표시
    const onScroll = () => {
        const body = bodyRef.current;
        if (!body) return;
        let current = sections[0]?.id;
        for (const s of sections) {
            const el = sectionRefs.current.get(s.id);
            if (el && el.offsetTop <= body.scrollTop + 24) current = s.id;
        }
        // 맨 아래까지 내렸으면 마지막 부분
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) current = sections[sections.length - 1]?.id;
        if (current && current !== activeId) setActiveId(current);
    };

    const jump = (id: string) => {
        const el = sectionRefs.current.get(id);
        const body = bodyRef.current;
        if (el && body) body.scrollTo({top: el.offsetTop - 8});
        setActiveId(id);
    };

    return (
        <>
            <div className={cx("modalOverlay")} onClick={onClose} />
            <div className={cx("guideDialog")} role="dialog" aria-label="사용 가이드">
                <div className={cx("guideHeader")}>
                    <span className={cx("guideTitle")}>사용 가이드</span>
                    <span className={cx("guideSearch")}>
                        <FontAwesomeIcon icon={faMagnifyingGlass} className={cx("guideSearchIcon")} />
                        <input
                            className={cx("guideSearchInput")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (isImeComposing(e)) return;
                                if (e.key === "Escape" && query) {
                                    e.stopPropagation();
                                    e.nativeEvent.stopImmediatePropagation();
                                    setQuery("");
                                }
                            }}
                            placeholder="기능 찾기 (예: 되돌리기, 탭, 알림)"
                            autoFocus
                        />
                    </span>
                    <button className={cx("guideClose")} onClick={onClose} title="닫기 (Esc)">
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                </div>
                <div className={cx("guideMain")}>
                    <nav className={cx("guideToc")}>
                        {sections.map((s) => (
                            <button key={s.id} className={cx("guideTocItem", {guideTocActive: s.id === activeId})} onClick={() => jump(s.id)}>
                                <FontAwesomeIcon icon={ICONS[s.icon] ?? faCircleInfo} className={cx("guideTocIcon")} />
                                <span className={cx("guideTocLabel")}>{s.title}</span>
                                <span className={cx("guideTocCount")}>{s.items.length}</span>
                            </button>
                        ))}
                    </nav>
                    <div className={cx("guideBody")} ref={bodyRef} onScroll={onScroll}>
                        {sections.length === 0 && <div className={cx("guideEmpty")}>"{query.trim()}"에 맞는 설명이 없습니다</div>}
                        {sections.map((s) => (
                            <section
                                key={s.id}
                                className={cx("guideSection")}
                                ref={(el) => {
                                    if (el) sectionRefs.current.set(s.id, el);
                                    else sectionRefs.current.delete(s.id);
                                }}
                            >
                                <h2 className={cx("guideSectionTitle")}>
                                    <FontAwesomeIcon icon={ICONS[s.icon] ?? faCircleInfo} /> {s.title}
                                </h2>
                                {s.intro && !q && <p className={cx("guideIntro")}>{s.intro}</p>}
                                {s.items.map((it) => (
                                    <article key={it.title} className={cx("guideItem")}>
                                        <h3 className={cx("guideItemTitle")}>
                                            {it.title}
                                            {it.since && <span className={cx("guideSince")}>{it.since}</span>}
                                        </h3>
                                        <p className={cx("guideItemBody")}>
                                            <Rich text={it.body} />
                                        </p>
                                        {it.how && it.how.length > 0 && (
                                            <ul className={cx("guideHow")}>
                                                {it.how.map((h, i) => (
                                                    <li key={i}>
                                                        <Rich text={h} />
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </article>
                                ))}
                            </section>
                        ))}
                    </div>
                </div>
            </div>
        </>
    );
}
