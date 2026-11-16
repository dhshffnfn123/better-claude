import {type RefObject, useCallback, useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faChevronUp, faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {isImeComposing} from "./ChatInput";

const cx = classNames.bind(styles);

// ⌘F 찾기 — 보고 있는 탭의 대화(메시지 목록) 안에서만 찾는다.
//
// Electron의 webContents.findInPage는 쓰지 않는다: 찾기 칸에 친 글자까지 찾아 버리고(칸이 페이지 안에 있다)
// 머리줄·사이드바까지 화면 전체를 뒤진다. 대신 글자 노드를 직접 훑어 Range를 만들고
// CSS Custom Highlight API(CSS.highlights)로 칠한다 — DOM을 바꾸지 않아 React와 부딪히지 않는다.
// 칠하는 색은 styles/index.css의 ::highlight(bc-find) / ::highlight(bc-find-current).

type HighlightCtor = new (...ranges: Range[]) => object;
interface HighlightRegistryLike {
    set(name: string, highlight: object): void;
    delete(name: string): boolean;
}
const HighlightClass = (globalThis as unknown as {Highlight?: HighlightCtor}).Highlight;
const highlightRegistry = (CSS as unknown as {highlights?: HighlightRegistryLike}).highlights;

const MATCH = "bc-find";
const CURRENT = "bc-find-current";
// 칠하기는 문서 전체에 하나다. 탭을 옮길 때 숨는 탭이 새 탭이 칠한 것을 지우지 않도록, 마지막에 칠한 쪽만 지운다.
let paintedBy: symbol | null = null;

// 같은 덩어리(문단·목록 항목·코드 블록 …) 안의 글자 노드는 이어 붙여 찾는다 — **굵게** 같은 서식이 끼어 있어도 찾게.
// 덩어리를 넘어서는 잇지 않는다 (문단 끝과 다음 문단 첫머리가 이어져 잘못 찾히지 않게).
const BLOCK = "p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote,summary,dt,dd,div";

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRanges(root: HTMLElement, query: string): Range[] {
    if (!query) return [];
    const groups: {nodes: Text[]; starts: number[]; text: string}[] = [];
    let current: {nodes: Text[]; starts: number[]; text: string} | null = null;
    let currentBlock: Element | null = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (!n.nodeValue) continue;
        const block = n.parentElement?.closest(BLOCK) ?? root;
        if (block !== currentBlock || !current) {
            current = {nodes: [], starts: [], text: ""};
            groups.push(current);
            currentBlock = block;
        }
        current.starts.push(current.text.length);
        current.nodes.push(n);
        current.text += n.nodeValue;
    }
    const re = new RegExp(escapeRegExp(query), "giu");
    const ranges: Range[] = [];
    for (const g of groups) {
        // 덩어리 안의 글자 위치 → (노드, 노드 안 위치). 끝 위치가 노드 경계면 앞 노드의 끝으로 잡는다.
        const at = (pos: number, isEnd: boolean): [Text, number] => {
            let i = g.starts.length - 1;
            while (i > 0 && (isEnd ? g.starts[i] >= pos : g.starts[i] > pos)) i--;
            return [g.nodes[i], pos - g.starts[i]];
        };
        for (const m of g.text.matchAll(re)) {
            if (!m[0]) continue;
            const start = m.index ?? 0;
            const [sNode, sOff] = at(start, false);
            const [eNode, eOff] = at(start + m[0].length, true);
            const range = document.createRange();
            range.setStart(sNode, sOff);
            range.setEnd(eNode, eOff);
            // 접힌 내용(닫힌 <details> 등)은 화면에 없다 — 건너뛴다
            if (range.getClientRects().length > 0) ranges.push(range);
        }
    }
    return ranges;
}

interface Props {
    listRef: RefObject<HTMLDivElement>;
    active: boolean; // 보이는 탭만 칠한다
    contentKey: unknown; // 바뀌면(응답이 흘러 들어오면) 다시 찾는다
    focusSeq: number; // ⌘F를 다시 누르면 찾기 칸으로
    step: {dir: 1 | -1; seq: number} | null; // ⌘G / ⇧⌘G
    onClose: () => void;
    onJump: () => void; // 찾은 곳으로 대화를 넘길 때 — 맨 아래 따라가기를 푼다 (같은 함수를 계속 넘길 것)
}

export function FindBar({listRef, active, contentKey, focusSeq, step, onClose, onJump}: Props) {
    const [query, setQuery] = useState("");
    const [count, setCount] = useState(0);
    const [index, setIndex] = useState(0);
    const rangesRef = useRef<Range[]>([]);
    const indexRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const tokenRef = useRef(Symbol("find"));

    const paint = useCallback((ranges: Range[], i: number) => {
        if (!HighlightClass || !highlightRegistry) return;
        if (ranges.length === 0) {
            if (paintedBy !== tokenRef.current) return;
            highlightRegistry.delete(MATCH);
            highlightRegistry.delete(CURRENT);
            paintedBy = null;
            return;
        }
        highlightRegistry.set(MATCH, new HighlightClass(...ranges));
        highlightRegistry.set(CURRENT, new HighlightClass(ranges[i]));
        paintedBy = tokenRef.current;
    }, []);

    // 찾은 곳이 보이게 대화를 넘긴다 (가로로 긴 코드 블록 안이면 그 블록도 옆으로)
    const reveal = useCallback(
        (range: Range | undefined) => {
            const list = listRef.current;
            if (!list || !range) return;
            const rect = range.getBoundingClientRect();
            const box = list.getBoundingClientRect();
            if (rect.top < box.top + 48 || rect.bottom > box.bottom - 24) {
                onJump();
                list.scrollTop += rect.top - box.top - box.height / 3;
            }
            const pre = range.startContainer.parentElement?.closest("pre");
            if (pre && pre.scrollWidth > pre.clientWidth) {
                const r = range.getBoundingClientRect();
                const p = pre.getBoundingClientRect();
                if (r.left < p.left || r.right > p.right) pre.scrollLeft += r.left - p.left - p.width / 3;
            }
        },
        [listRef, onJump]
    );

    // 찾기. moveToFirst: 검색어를 새로 쳤을 때 — 첫 결과로 옮겨 보여 준다. 내용만 바뀌었을 때는 자리를 지킨다.
    const search = useCallback(
        (moveToFirst: boolean) => {
            const list = listRef.current;
            const ranges = list ? findRanges(list, query.trim()) : [];
            rangesRef.current = ranges;
            const i = moveToFirst ? 0 : Math.min(indexRef.current, Math.max(0, ranges.length - 1));
            indexRef.current = i;
            setIndex(i);
            setCount(ranges.length);
            paint(ranges, i);
            if (moveToFirst) reveal(ranges[i]);
        },
        [listRef, query, paint, reveal]
    );

    // 검색어가 바뀌면 바로 찾아 첫 결과로. 다시 보이게 됐을 때는 다시 칠하기만 한다.
    const searchedQueryRef = useRef<string | null>(null);
    useEffect(() => {
        if (!active) return;
        const fresh = searchedQueryRef.current !== query;
        searchedQueryRef.current = query;
        search(fresh);
    }, [active, query, search]);

    // 내용이 바뀌면(응답이 흘러 들어오면) 0.3초에 한 번만 다시 찾는다 — 흘러 들어오는 내내 결과가 따라온다
    const searchLatest = useRef(search);
    useEffect(() => {
        searchLatest.current = search;
    }, [search]);
    const timerRef = useRef<number | null>(null);
    useEffect(() => {
        if (!active || timerRef.current != null) return;
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            searchLatest.current(false);
        }, 300);
    }, [contentKey, active]);
    useEffect(
        () => () => {
            if (timerRef.current != null) window.clearTimeout(timerRef.current);
        },
        []
    );

    const go = useCallback(
        (dir: 1 | -1) => {
            const ranges = rangesRef.current;
            if (ranges.length === 0) return;
            const i = (indexRef.current + dir + ranges.length) % ranges.length;
            indexRef.current = i;
            setIndex(i);
            paint(ranges, i);
            reveal(ranges[i]);
        },
        [paint, reveal]
    );

    // ⌘G / ⇧⌘G — 같은 누름을 두 번 처리하지 않게 번호로 가린다
    const handledStepRef = useRef(step?.seq ?? 0);
    useEffect(() => {
        if (!step || step.seq === handledStepRef.current) return;
        handledStepRef.current = step.seq;
        go(step.dir);
    }, [step, go]);

    // ⌘F: 찾기 칸으로 (이미 열려 있어도)
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusSeq]);

    // 안 보이게 되거나 닫으면 칠한 것을 지운다
    useEffect(() => {
        if (!active) paint([], 0);
    }, [active, paint]);
    useEffect(() => () => paint([], 0), [paint]);

    const trimmed = query.trim();
    return (
        <div className={cx("findBar")} role="search">
            <input
                ref={inputRef}
                className={cx("findInput")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key === "Enter") {
                        e.preventDefault();
                        go(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        onClose();
                    }
                }}
                placeholder="대화에서 찾기"
                aria-label="대화에서 찾기"
                spellCheck={false}
            />
            <span className={cx("findCount", {findCountNone: !!trimmed && count === 0})}>
                {trimmed ? (count > 0 ? `${index + 1}/${count}` : "없음") : ""}
            </span>
            <button className={cx("findBtn")} onClick={() => go(-1)} disabled={count === 0} aria-label="이전" title="이전 (⇧⌘G · ⇧Enter)">
                <FontAwesomeIcon icon={faChevronUp} />
            </button>
            <button className={cx("findBtn")} onClick={() => go(1)} disabled={count === 0} aria-label="다음" title="다음 (⌘G · Enter)">
                <FontAwesomeIcon icon={faChevronDown} />
            </button>
            <button className={cx("findBtn")} onClick={onClose} aria-label="닫기" title="닫기 (Esc)">
                <FontAwesomeIcon icon={faXmark} />
            </button>
        </div>
    );
}
