import type {ReactNode} from "react";
import {Children, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState} from "react";
import ReactMarkdown, {type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faChevronDown,
    faChevronRight,
    faClockRotateLeft,
    faCopy,
    faDownLeftAndUpRightToCenter,
    faPen,
    faRotateRight,
} from "@fortawesome/free-solid-svg-icons";
import claudeIcon from "../../assets/better-claude-icon.png";
import styles from "./chat.page.module.scss";
import type {CompactSegment, Message} from "../../hooks/useClaudeChat";
import {copyText} from "../../clipboard";
import {highlightLanguage} from "../../highlight";
import {editorHint, looksLikeFilePath, openFileRef, resolveFileRef} from "../../file-links";
import {TabIdContext} from "../../tab-context";
import {QUESTION_TOOL} from "../../question-answers";
import {ToolRow} from "./ActivityPanel";
import {QuestionCard} from "./QuestionCard";
import {isImeComposing} from "./ChatInput";

const cx = classNames.bind(styles);

// 복사 버튼: 누르면 잠깐 "복사됨"으로 바뀐다
function useCopied(): [boolean, (text: string) => void] {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | null>(null);
    useEffect(() => () => {
        if (timer.current != null) window.clearTimeout(timer.current);
    }, []);
    const copy = (text: string) => {
        void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
    };
    return [copied, copy];
}

// React 요소 안의 글자만 모은다 (코드 블록의 원래 코드)
function textOf(node: ReactNode): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement<{children?: ReactNode}>(node)) return textOf(node.props.children);
    return "";
}

// 코드 블록(```): 언어 표시 + 복사 버튼 + 문법 색상. 답이 흘러 들어오는 동안에는 글자가 바뀐 블록만 다시 칠한다.
function CodeBlock({lang, code}: {lang?: string; code: string}) {
    const html = useMemo(() => highlightLanguage(code, lang), [code, lang]);
    const [copied, copy] = useCopied();
    return (
        <div className={cx("codeBlock")}>
            <div className={cx("codeBlockHead")}>
                <span className={cx("codeBlockLang")}>{lang ?? ""}</span>
                <button className={cx("codeBlockCopy")} onClick={() => copy(code)} aria-label="코드 복사">
                    <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                    {copied ? "복사됨" : "복사"}
                </button>
            </div>
            {/* highlight.js가 글자를 이스케이프해 만든 HTML이다 */}
            <pre className={cx("codeBlockPre")}>
                <code dangerouslySetInnerHTML={{__html: html}} />
            </pre>
        </div>
    );
}

// 답변 속 파일 경로 `src/main.ts:120` — 마우스를 올리면 열 수 있는지 알아보고, ⌘+클릭으로 JetBrains IDE에서 연다.
// 그냥 클릭은 글자를 고르는 데 쓰이므로 ⌘가 필요하다(JetBrains의 ⌘+클릭 이동과 같다).
function FileCode({text}: {text: string}) {
    const tabId = useContext(TabIdContext);
    const [target, setTarget] = useState<EditorTarget | null>(null);
    const resolve = () => {
        if (tabId && !target) void resolveFileRef(tabId, text).then(setTarget);
    };
    return (
        <code
            className={cx({pathCode: target?.ok === true})}
            onMouseEnter={resolve}
            onClick={(e) => {
                if (!e.metaKey || !tabId) return;
                e.preventDefault();
                void openFileRef(tabId, text).then(setTarget);
            }}
            data-tooltip={target?.ok ? editorHint(target, true) : undefined}
        >
            {text}
        </code>
    );
}

// 마크다운 파일 링크 [main.ts](src/main.ts#L120) — 그냥 클릭으로 IDE에서 연다 (예전에는 눌러도 아무 일이 없었다)
function FileLink({href, children}: {href: string; children: ReactNode}) {
    const tabId = useContext(TabIdContext);
    const [target, setTarget] = useState<EditorTarget | null>(null);
    return (
        <a
            href={href}
            onMouseEnter={() => {
                if (tabId && !target) void resolveFileRef(tabId, href).then(setTarget);
            }}
            onClick={(e) => {
                e.preventDefault();
                if (tabId) void openFileRef(tabId, href).then(setTarget);
            }}
            data-tooltip={target ? editorHint(target, false) : href}
        >
            {children}
        </a>
    );
}

const MARKDOWN_COMPONENTS: Components = {
    // 웹 링크는 새 창 요청으로 보낸다. main(link-guard)이 기본 브라우저로 연다 — 그냥 두면 앱 창이 그 페이지로 넘어간다.
    // 그 밖의 링크(상대 경로·파일)는 파일로 보고 IDE에서 연다.
    a: ({href, title, children}) => {
        if (href && !/^(https?:|mailto:|#)/i.test(href)) return <FileLink href={href}>{children}</FileLink>;
        return (
            <a href={href} title={title ?? href} target="_blank" rel="noreferrer noopener">
                {children}
            </a>
        );
    },
    // 문장 속 `코드` 중 파일 경로처럼 보이는 것. 코드 블록 안의 code는 아래 pre가 통째로 바꾸므로 여기로 오지 않는다.
    code: ({className, children}) =>
        !className && typeof children === "string" && looksLikeFilePath(children) ? (
            <FileCode text={children} />
        ) : (
            <code className={className}>{children}</code>
        ),
    // 코드 블록만 바꾼다 — 문장 속 `코드`는 <pre> 밖이라 그대로 남는다
    pre: ({children}) => {
        const code = Children.toArray(children)[0];
        if (!isValidElement<{className?: string; children?: ReactNode}>(code)) return <pre>{children}</pre>;
        const lang = /language-([^\s]+)/.exec(code.props.className ?? "")?.[1];
        return <CodeBlock lang={lang} code={textOf(code.props.children).replace(/\n$/, "")} />;
    },
};

// 답변 전체 복사 (마크다운 원문)
function CopyMessageButton({text}: {text: string}) {
    const [copied, copy] = useCopied();
    return (
        <button className={cx("msgActionBtn")} onClick={() => copy(text)} title="이 답변을 마크다운 그대로 복사합니다">
            <FontAwesomeIcon icon={copied ? faCheck : faCopy} /> {copied ? "복사됨" : "복사"}
        </button>
    );
}

// 대화 압축 — 답변 자리의 구분선. 위쪽 대화가 요약으로 바뀌었다는 표시이고, 요약 본문(CLI가 쓴 영어)은 눌러서 펼친다.
// 기록에서 불러온 대화는 마지막 압축부터만 보이므로(그 앞은 요약 속에만 있다) 맨 위에 "이전 대화 요약"으로 온다.
function CompactDivider({seg}: {seg: CompactSegment}) {
    const [open, setOpen] = useState(false);
    const meta = [
        seg.trigger === "manual" ? "/compact" : seg.trigger === "auto" ? "대화가 길어 자동으로" : null,
        seg.preTokens != null && seg.postTokens != null
            ? `컨텍스트 ${seg.preTokens.toLocaleString()} → ${seg.postTokens.toLocaleString()} 토큰`
            : null,
    ].filter(Boolean);
    return (
        <div className={cx("compactBlock")}>
            <div className={cx("compactRule")}>
                <span className={cx("compactTitle")}>
                    <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} />
                    {seg.restored ? "이전 대화 요약" : "여기까지의 대화를 요약했습니다"}
                </span>
            </div>
            {(meta.length > 0 || seg.summary) && (
                <div className={cx("compactMeta")}>
                    {meta.length > 0 && <span>{meta.join(" · ")}</span>}
                    {seg.summary && (
                        <button className={cx("compactToggle")} onClick={() => setOpen((v) => !v)}>
                            <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} />
                            요약 {open ? "접기" : "보기"}
                        </button>
                    )}
                </div>
            )}
            {/* 마크다운으로 그리지 않는다 — 들여쓰기로 짠 글이라 목록 사이가 크게 벌어진다. 원문 줄바꿈·들여쓰기 그대로. */}
            {open && seg.summary && <div className={cx("compactSummary")}>{seg.summary}</div>}
        </div>
    );
}

interface Props {
    msg: Message;
    isStreaming: boolean;
    onImageClick?: (src: string) => void;
    onRegenerate?: () => void;
    onEditResend?: (text: string) => void;
    onRewindFiles?: (uuid: string) => void;
}

function MessageItemBase({msg, isStreaming, onImageClick, onRegenerate, onEditResend, onRewindFiles}: Props) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(msg.content);

    useEffect(() => {
        if (!editing) setDraft(msg.content);
    }, [msg.content, editing]);

    const saveEdit = () => {
        const t = draft.trim();
        if (!t) return;
        onEditResend?.(t);
        setEditing(false);
    };

    // 압축 구분선도 "보이는 내용" — 그 아래에 생각 중 점이 남지 않게
    const hasVisibleText =
        msg.segments?.some((s) => (s.kind === "text" && s.text.trim().length > 0) || s.kind === "compact") ?? false;
    const hasCompact = msg.segments?.some((s) => s.kind === "compact") ?? false;
    // /compact의 답처럼 구분선뿐인 답변 — 다시 생성할 것이 없다
    const compactOnly = hasCompact && (msg.segments?.every((s) => s.kind === "compact") ?? false);
    const showRegenerate = !!onRegenerate && msg.role === "assistant" && !compactOnly;
    // 다 받은 답변만 복사할 수 있다 (첫 인사말 제외)
    const canCopy = msg.role === "assistant" && !msg.greeting && !isStreaming && msg.content.trim().length > 0;
    return (
        // data-msg-id·data-role: 탭 화면이 "지금 읽는 답변"을 찾는 데 쓴다 (답변 처음으로 버튼)
        <div className={cx("messageWrapper", msg.role)} data-msg-id={msg.id} data-role={msg.role}>
            {/* 구분선이 든 답변은 폭을 끝까지 쓴다 — 내용 폭에 맞춰 줄면 구분선이 짧게 끊긴다 */}
            <div className={cx("messageInner", {messageInnerWide: hasCompact})}>
                <div className={cx("sender")}>
                    {msg.role === "assistant" && (
                        <img src={claudeIcon} className={cx("senderIcon")} alt="" />
                    )}
                    {msg.role === "user" ? "나" : "Claude"}
                    {/* 0은 띄우지 않는다 — /compact·/cost처럼 모델이 답하지 않은 턴 */}
                    {msg.role === "user" && !!msg.inputTokens && (
                        <span className={cx("tokenBadge")}>{msg.inputTokens.toLocaleString()} tokens</span>
                    )}
                    {msg.role === "assistant" && !!msg.outputTokens && (
                        <span className={cx("tokenBadge")}>{msg.outputTokens.toLocaleString()} tokens</span>
                    )}
                </div>
                {msg.images && msg.images.length > 0 && (
                    <div className={cx("messageBubbleImages")}>
                        {msg.images.map((src, i) => (
                            <img
                                key={i}
                                src={src}
                                className={cx("messageBubbleImage")}
                                alt=""
                                onClick={() => onImageClick?.(src)}
                            />
                        ))}
                    </div>
                )}
                {msg.role === "user" ? (
                    editing ? (
                        <div className={cx("editBox")}>
                            <textarea
                                className={cx("editTextarea")}
                                value={draft}
                                autoFocus
                                rows={Math.min(draft.split("\n").length + 1, 10)}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (isImeComposing(e)) return;
                                    if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        saveEdit();
                                    }
                                    if (e.key === "Escape") setEditing(false);
                                }}
                            />
                            <div className={cx("editActions")}>
                                <button className={cx("editBtn")} onClick={() => setEditing(false)}>
                                    취소
                                </button>
                                <button className={cx("editBtn", "editBtnPrimary")} onClick={saveEdit}>
                                    보내기
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className={cx("bubble")}>
                            {msg.content.split("\n").map((line, i, arr) => (
                                <span key={i}>
                                    {line}
                                    {i < arr.length - 1 && <br />}
                                </span>
                            ))}
                        </div>
                    )
                ) : msg.segments && msg.segments.length > 0 ? (
                    // 어시스턴트: 텍스트 말풍선과 도구를 발생 순서대로 분리 렌더
                    <div className={cx("segmentList")}>
                        {msg.segments.map((seg, i) =>
                            seg.kind === "compact" ? (
                                <CompactDivider key={i} seg={seg} />
                            ) : seg.kind === "tool" ? (
                                seg.tool.name === QUESTION_TOOL ? (
                                    <QuestionCard key={seg.tool.id} tool={seg.tool} />
                                ) : (
                                    <ToolRow key={seg.tool.id} tool={seg.tool} defaultExpanded />
                                )
                            ) : seg.text.trim() ? (
                                <div key={i} className={cx("bubble", "markdown")}>
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                                        {seg.text}
                                    </ReactMarkdown>
                                </div>
                            ) : null
                        )}
                        {isStreaming && !hasVisibleText && (
                            <div className={cx("bubble", "markdown")}>
                                <span className={cx("thinking")}>
                                    <span />
                                    <span />
                                    <span />
                                </span>
                            </div>
                        )}
                    </div>
                ) : (
                    // segments 없는 경우(불러온 대화, 응답 시작 직전)
                    <div className={cx("bubble", "markdown")}>
                        {isStreaming && !msg.content ? (
                            <span className={cx("thinking")}>
                                <span />
                                <span />
                                <span />
                            </span>
                        ) : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                                {msg.content}
                            </ReactMarkdown>
                        )}
                    </div>
                )}
                {(showRegenerate || (onRewindFiles && msg.uuid) || onEditResend || canCopy) && !editing && (
                    <div className={cx("msgActions")}>
                        {canCopy && <CopyMessageButton text={msg.content} />}
                        {onEditResend && !editing && msg.role === "user" && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => {
                                    setDraft(msg.content);
                                    setEditing(true);
                                }}
                                title="이 메시지를 고쳐서 다시 보냅니다. 기존 답변은 버려지고, 그 답변이 고친 파일은 그대로 남습니다"
                            >
                                <FontAwesomeIcon icon={faPen} /> 편집
                            </button>
                        )}
                        {onRewindFiles && msg.uuid && msg.role === "user" && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => msg.uuid && onRewindFiles(msg.uuid)}
                                title="이 메시지를 보내기 직전 상태로, Claude가 Write·Edit 도구로 고친 파일을 되돌립니다 (대화는 그대로)"
                            >
                                <FontAwesomeIcon icon={faClockRotateLeft} /> 파일 되돌리기
                            </button>
                        )}
                        {showRegenerate && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={onRegenerate}
                                title="이 답변을 버리고 다시 생성합니다. 이 답변이 고친 파일은 그대로 남습니다 (필요하면 먼저 '파일 되돌리기')"
                            >
                                <FontAwesomeIcon icon={faRotateRight} /> 재생성
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export const MessageItem = memo(MessageItemBase);
