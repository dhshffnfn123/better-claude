import {useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faBrain, faChevronRight} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {onAnyTab} from "../../tab-events";
import {memoryToastEnabled, useMemoryToastEnabled} from "../../memory-toast-setting";

const cx = classNames.bind(styles);

// 기억 알림 — "클로드는 이것을 기억할 것입니다" + 무엇을 기억했는지(기억의 description).
// main이 Claude의 기억 저장(Write·Edit 성공)을 탭마다 chat:memory_saved로 알린다. 창 가운데에 살짝 커지며 나타나 3초쯤
// 머물다가 위로 스르륵 사라진다(움직임 줄이기 설정이면 흐려지기만). 그 탭을 보고 있으면 바로, 아니면 그 탭으로 갈 때
// 보인다(탭마다 최근 몇 개만). 여러 개면 하나씩 차례로. 누르면 지침 패널의 기억 탭에서 그 기억을 연다.
// 마우스를 올리면 기다리고, 떼면 조금 더 있다가 사라진다. 눌러지는 건 카드뿐이다(나머지 화면은 그대로 쓴다).

const SHOW_MS = 200 + 3000; // 나타나기 + 머무르기
const LEAVE_MS = 600; // 사라지기 — scss의 mem-toast-out과 같게
const CLOSE_MS = 180; // 눌러서 닫기 — scss의 memToastClosing과 같게
const GAP_MS = 150; // 다음 알림 전 쉼
const AFTER_HOVER_MS = 1500; // 마우스를 뗀 뒤 더 머무르기
const KEEP_PER_TAB = 3; // 안 보는 탭에 쌓아 두는 수 (최근 것만)

interface Shown {
    key: number;
    tabId: string;
    item: MemorySavedEvent;
}

function fileLabel(p: string): string {
    return p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

// 설명 속 `코드`는 코드 글씨로 — 기억 설명에는 명령·경로가 자주 들어간다. 짝이 없는 마지막 `는 그대로 둔다.
function withCode(text: string): React.ReactNode {
    const parts = text.split("`");
    if (parts.length < 3) return text;
    if (parts.length % 2 === 0) parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]}\`${parts[parts.length - 1]}`);
    return parts.map((p, i) =>
        i % 2 === 1 ? (
            <code key={i} className={cx("memToastCode")}>
                {p}
            </code>
        ) : (
            p
        )
    );
}

// 같은 기억이 또 오면(쓰고 곧바로 고침) 하나로 — 내용은 새것, "고침"은 앞의 것을 따른다(방금 만든 기억을 고친 건 새 기억)
function merge(prev: MemorySavedEvent, next: MemorySavedEvent): MemorySavedEvent {
    return {...next, updated: prev.updated && next.updated};
}

interface Props {
    activeTabId: string | null;
    tabIds: string[];
    onOpen: (tabId: string, path: string) => void;
}

export function MemoryToasts({activeTabId, tabIds, onOpen}: Props) {
    const [enabled] = useMemoryToastEnabled();
    // 탭마다 아직 못 보여 준 알림 (보고 있는 탭의 것만 띄운다)
    const queues = useRef(new Map<string, MemorySavedEvent[]>());
    const [queued, setQueued] = useState(0); // 대기열이 바뀌면 올린다 — 다음 알림을 다시 고르게
    const [shown, setShown] = useState<Shown | null>(null);
    const [leaving, setLeaving] = useState(false);
    const [closing, setClosing] = useState(false);
    const [hover, setHover] = useState(false);
    const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
    const keyRef = useRef(0);
    const holdRef = useRef(SHOW_MS);
    const shownRef = useRef(shown);
    shownRef.current = shown;
    const leavingRef = useRef(leaving || closing);
    leavingRef.current = leaving || closing;

    // 창이 가려져(최소화 등) 안 보이는 동안은 띄우지 않는다 — 아무도 못 본 채 사라지지 않게, 다시 보일 때 띄운다
    useEffect(() => {
        const onChange = () => setPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", onChange);
        return () => document.removeEventListener("visibilitychange", onChange);
    }, []);

    useEffect(
        () =>
            onAnyTab("memorySaved", (tabId, ev) => {
                if (!memoryToastEnabled() || !ev?.path) return;
                // 지금 떠 있는 그 기억이면 그 자리에서 내용만 바꾼다
                const cur = shownRef.current;
                if (cur && cur.tabId === tabId && cur.item.path === ev.path && !leavingRef.current) {
                    setShown({...cur, item: merge(cur.item, ev)});
                    return;
                }
                const q = queues.current.get(tabId) ?? [];
                const i = q.findIndex((x) => x.path === ev.path);
                if (i >= 0) q[i] = merge(q[i], ev);
                else q.push(ev);
                queues.current.set(tabId, q.slice(-KEEP_PER_TAB));
                setQueued((n) => n + 1);
            }),
        []
    );

    // 끄면 기다리던 것은 버리고, 떠 있던 것은 바로 거둔다
    useEffect(() => {
        if (enabled) return;
        queues.current.clear();
        if (shownRef.current) setClosing(true);
    }, [enabled]);

    // 닫힌 탭의 대기열은 버린다
    const tabKey = tabIds.join("\n");
    useEffect(() => {
        const open = new Set(tabKey.split("\n"));
        for (const id of [...queues.current.keys()]) if (!open.has(id)) queues.current.delete(id);
    }, [tabKey]);

    // 다음 알림 — 보고 있는 탭의 것, 창이 보일 때
    useEffect(() => {
        if (shown || !enabled || !pageVisible || !activeTabId) return;
        const item = queues.current.get(activeTabId)?.shift();
        if (!item) return;
        holdRef.current = SHOW_MS;
        setLeaving(false);
        setClosing(false);
        setHover(false);
        setShown({key: ++keyRef.current, tabId: activeTabId, item});
    }, [shown, enabled, pageVisible, activeTabId, queued]);

    // 다른 탭으로 옮기면 그 탭의 알림은 바로 거둔다 (마우스가 올라가 있어도)
    useEffect(() => {
        if (!shown || shown.tabId === activeTabId) return;
        setHover(false);
        setClosing(true);
    }, [shown, activeTabId]);

    // 머무르기 → 사라지기 → (다 사라지면) 다음 것. 마우스가 올라가 있거나 창이 안 보이는 동안은 멈춘다.
    useEffect(() => {
        if (!shown || ((hover || !pageVisible) && !closing)) return;
        const ending = leaving || closing;
        const ms = closing ? CLOSE_MS + GAP_MS : leaving ? LEAVE_MS + GAP_MS : holdRef.current;
        const t = window.setTimeout(() => (ending ? setShown(null) : setLeaving(true)), ms);
        return () => window.clearTimeout(t);
    }, [shown, leaving, closing, hover, pageVisible]);

    const item = shown?.item;
    const text = item ? item.description || item.name || fileLabel(item.path) : "";

    return (
        // 알림이 없을 때도 둔다 — 화면 읽기 프로그램은 미리 있던 알림 영역에 생긴 글만 읽어 준다
        <div className={cx("memToastLayer")} role="status" aria-live="polite">
            {shown && item && (
                <button
                    key={shown.key}
                    type="button"
                    className={cx("memToast", {memToastLeaving: leaving && !closing, memToastClosing: closing})}
                    onClick={() => {
                        if (closing) return;
                        onOpen(shown.tabId, item.path);
                        setHover(false);
                        setClosing(true);
                    }}
                    onMouseEnter={() => {
                        if (closing) return;
                        setHover(true);
                        setLeaving(false);
                    }}
                    onMouseLeave={() => {
                        holdRef.current = AFTER_HOVER_MS;
                        setHover(false);
                    }}
                    title={text}
                    aria-label={`클로드는 이것을 기억할 것입니다${item.updated ? " (고침)" : ""}: ${text} — 눌러서 기억 보기`}
                >
                    <span className={cx("memToastIcon")}>
                        <FontAwesomeIcon icon={faBrain} />
                    </span>
                    <span className={cx("memToastText")}>
                        <span className={cx("memToastTitle")}>
                            클로드는 이것을 기억할 것입니다
                            {item.updated && <span className={cx("memToastBadge")}>고침</span>}
                        </span>
                        <span className={cx("memToastDesc")}>{withCode(text)}</span>
                    </span>
                    <FontAwesomeIcon icon={faChevronRight} className={cx("memToastGo")} />
                </button>
            )}
        </div>
    );
}
