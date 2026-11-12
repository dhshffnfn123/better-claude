import {memo, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faChevronDown,
    faChevronRight,
    faCircleNotch,
    faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {RunningTokens, ToolActivity} from "../../hooks/useClaudeChat";

const cx = classNames.bind(styles);

interface Props {
    isThinking: boolean;
    tools: ToolActivity[];
    thinkingText: string;
    elapsedMs: number;
    runningTokens: RunningTokens;
}

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

// 경로가 길면 끝(파일명)이 잘리지 않도록 가운데를 …로 줄인다. 웬만하면 전부 보여줌.
export function middleTruncate(s: string, max = 120): string {
    if (s.length <= max) return s;
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

// 도구 입력에서 대표 문자열(경로/명령 등) 원본을 그대로 뽑는다. (툴팁용)
function rawToolInput(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const obj = input as Record<string, unknown>;
    const keys = ["file_path", "path", "command", "pattern", "query", "url"];
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.length > 0) return v;
    }
    const first = Object.values(obj).find((v) => typeof v === "string" && v.length > 0);
    return typeof first === "string" ? first : "";
}

const DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

interface EditPair {
    oldStr: string;
    newStr: string;
}

function extractEditPairs(name: string, input: unknown): EditPair[] {
    if (!input || typeof input !== "object") return [];
    const obj = input as Record<string, unknown>;
    if (name === "Edit") {
        const oldStr = typeof obj.old_string === "string" ? obj.old_string : "";
        const newStr = typeof obj.new_string === "string" ? obj.new_string : "";
        return oldStr || newStr ? [{oldStr, newStr}] : [];
    }
    if (name === "Write") {
        const content = typeof obj.content === "string" ? obj.content : "";
        return content ? [{oldStr: "", newStr: content}] : [];
    }
    if (name === "MultiEdit") {
        const edits = Array.isArray(obj.edits) ? obj.edits : [];
        return edits
            .map((e) => {
                if (!e || typeof e !== "object") return {oldStr: "", newStr: ""};
                const ee = e as Record<string, unknown>;
                return {
                    oldStr: typeof ee.old_string === "string" ? ee.old_string : "",
                    newStr: typeof ee.new_string === "string" ? ee.new_string : "",
                };
            })
            .filter((p) => p.oldStr || p.newStr);
    }
    return [];
}

type DiffEntry = {type: "ctx" | "del" | "add"; text: string};

// LCS 표 크기 상한 (줄 수 × 줄 수). 넘으면 표를 만들지 않고 통째로 -/+ 표시 — 화면이 멈추지 않게
const MAX_DIFF_CELLS = 2_000_000;

// 라인 단위 LCS — old와 new를 비교해서 공통 줄은 컨텍스트로, 다른 줄만 -/+로 표시.
// 앞뒤의 같은 줄은 표 없이 먼저 떼어 낸다 (큰 파일의 일부만 고친 경우가 대부분이다).
// 빈 문자열은 줄이 없는 것(Write는 old가 비어 있다 — 예전엔 빈 "-" 줄이 찍혔다), 끝 줄바꿈 하나는 빈 줄로 세지 않는다.
function toLines(s: string): string[] {
    return s === "" ? [] : s.replace(/\n$/, "").split("\n");
}

function diffLines(oldStr: string, newStr: string): DiffEntry[] {
    const a = toLines(oldStr);
    const b = toLines(newStr);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const out: DiffEntry[] = a.slice(0, head).map((text) => ({type: "ctx", text}));
    const am = a.slice(head, a.length - tail);
    const bm = b.slice(head, b.length - tail);
    const m = am.length;
    const n = bm.length;
    if (m * n > MAX_DIFF_CELLS) {
        for (const text of am) out.push({type: "del", text});
        for (const text of bm) out.push({type: "add", text});
    } else {
        const dp: number[][] = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
        for (let i = m - 1; i >= 0; i--) {
            for (let j = n - 1; j >= 0; j--) {
                if (am[i] === bm[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
                else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (am[i] === bm[j]) {
                out.push({type: "ctx", text: am[i]});
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                out.push({type: "del", text: am[i]});
                i++;
            } else {
                out.push({type: "add", text: bm[j]});
                j++;
            }
        }
        while (i < m) out.push({type: "del", text: am[i++]});
        while (j < n) out.push({type: "add", text: bm[j++]});
    }
    for (const text of a.slice(a.length - tail)) out.push({type: "ctx", text});
    return out;
}

const DIFF_CLASS: Record<DiffEntry["type"], string> = {
    ctx: "diffContext",
    del: "diffRemove",
    add: "diffAdd",
};

const DIFF_MARKER: Record<DiffEntry["type"], string> = {
    ctx: " ",
    del: "-",
    add: "+",
};

export function ToolDiff({name, input}: {name: string; input: unknown}) {
    const pairs = extractEditPairs(name, input);
    if (pairs.length === 0) return null;
    return (
        <div className={cx("toolDiff")}>
            {pairs.map((p, idx) => {
                const entries = diffLines(p.oldStr, p.newStr);
                return (
                    <div key={idx} className={cx("toolDiffBlock")}>
                        {pairs.length > 1 && (
                            <div className={cx("toolDiffHeader")}>변경 #{idx + 1}</div>
                        )}
                        {entries.map((e, i) => (
                            <div key={i} className={cx("diffLine", DIFF_CLASS[e.type])}>
                                <span className={cx("diffMarker")}>{DIFF_MARKER[e.type]}</span>
                                <span className={cx("diffText")}>{e.text || " "}</span>
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

export function ToolRow({tool, defaultExpanded = false}: {tool: ToolActivity; defaultExpanded?: boolean}) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const expandable = DIFF_TOOLS.has(tool.name) && extractEditPairs(tool.name, tool.input).length > 0;
    const rawInput = rawToolInput(tool.input);
    const icon =
        tool.status === "running"
            ? faCircleNotch
            : tool.status === "error"
                ? faTriangleExclamation
                : faCheck;
    return (
        <div className={cx("toolRowGroup")}>
            <div
                className={cx("toolRow", tool.status, {toolRowExpandable: expandable, toolRowSub: !!tool.parentToolUseId})}
                onClick={expandable ? () => setExpanded((v) => !v) : undefined}
            >
                {expandable ? (
                    <FontAwesomeIcon
                        icon={expanded ? faChevronDown : faChevronRight}
                        className={cx("toolExpandIcon")}
                    />
                ) : (
                    <span className={cx("toolExpandIcon")} />
                )}
                <FontAwesomeIcon
                    icon={icon}
                    spin={tool.status === "running"}
                    className={cx("toolIcon")}
                />
                <span className={cx("toolName")}>{tool.name}</span>
                <span className={cx("toolInput")} title={rawInput || undefined}>
                    {middleTruncate(rawInput)}
                </span>
            </div>
            {expandable && expanded && <ToolDiff name={tool.name} input={tool.input} />}
        </div>
    );
}

function ActivityPanelBase({isThinking, tools, thinkingText, elapsedMs, runningTokens}: Props) {
    const [thinkingOpen, setThinkingOpen] = useState(false);
    const hasTokens = runningTokens.input + runningTokens.output > 0;

    return (
        <div className={cx("activityPanel")}>
            <div className={cx("activityHeader")}>
                {tools.length === 0 ? (
                    isThinking ? (
                        <span className={cx("activityLabel")}>
                            <span className={cx("statusDots")}>
                                <span /><span /><span />
                            </span>
                            생각 중
                        </span>
                    ) : (
                        <span className={cx("activityLabel")}>
                            <span className={cx("statusSpinner")} />
                            응답 생성 중
                        </span>
                    )
                ) : (
                    <span className={cx("activityLabel")}>
                        <span className={cx("statusSpinner")} />
                        작업 중 · {tools.filter((t) => t.status === "running").length} 실행
                    </span>
                )}
                <span className={cx("activitySpacer")} />
                <span className={cx("activityTimer")}>{formatElapsed(elapsedMs)}</span>
                {hasTokens && (
                    <span className={cx("activityTokens")}>
                        ↑{runningTokens.input.toLocaleString()} ↓{runningTokens.output.toLocaleString()}
                    </span>
                )}
            </div>

            {tools.length > 0 && (
                <div className={cx("toolList")}>
                    {tools.slice(-6).map((t) => (
                        <ToolRow key={t.id} tool={t} />
                    ))}
                </div>
            )}

            {thinkingText && (
                <div className={cx("thinkingSection")}>
                    <button
                        className={cx("thinkingToggle")}
                        onClick={() => setThinkingOpen((v) => !v)}
                    >
                        <FontAwesomeIcon icon={thinkingOpen ? faChevronDown : faChevronRight} />
                        <span>Claude의 생각 {thinkingOpen ? "접기" : "보기"}</span>
                    </button>
                    {thinkingOpen && <pre className={cx("thinkingBody")}>{thinkingText}</pre>}
                </div>
            )}
        </div>
    );
}

export const ActivityPanel = memo(ActivityPanelBase);
