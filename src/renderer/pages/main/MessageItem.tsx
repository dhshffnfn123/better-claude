import type {ReactNode} from "react";
import {Children, isValidElement, memo, useEffect, useMemo, useRef, useState} from "react";
import ReactMarkdown, {type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faClockRotateLeft, faCopy, faPen, faRotateRight} from "@fortawesome/free-solid-svg-icons";
import claudeIcon from "../../assets/better-claude-icon.png";
import styles from "./chat.page.module.scss";
import type {Message} from "../../hooks/useClaudeChat";
import {copyText} from "../../clipboard";
import {highlightLanguage} from "../../highlight";
import {ToolRow} from "./ActivityPanel";
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

const MARKDOWN_COMPONENTS: Components = {
    // 링크는 새 창 요청으로 보낸다. main(link-guard)이 웹 링크만 기본 브라우저로 열고 나머지는 막는다.
    // 그냥 두면 링크를 누르는 순간 앱 창이 그 페이지로 넘어가 버린다.
    a: ({href, title, children}) => (
        <a href={href} title={title ?? href} target="_blank" rel="noreferrer noopener">
            {children}
        </a>
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

    const hasVisibleText =
        msg.segments?.some((s) => s.kind === "text" && s.text.trim().length > 0) ?? false;
    // 다 받은 답변만 복사할 수 있다 (첫 인사말 제외)
    const canCopy = msg.role === "assistant" && !msg.greeting && !isStreaming && msg.content.trim().length > 0;
    return (
        <div className={cx("messageWrapper", msg.role)}>
            <div className={cx("messageInner")}>
                <div className={cx("sender")}>
                    {msg.role === "assistant" && (
                        <img src={claudeIcon} className={cx("senderIcon")} alt="" />
                    )}
                    {msg.role === "user" ? "나" : "Claude"}
                    {msg.role === "user" && msg.inputTokens != null && (
                        <span className={cx("tokenBadge")}>{msg.inputTokens.toLocaleString()} tokens</span>
                    )}
                    {msg.role === "assistant" && msg.outputTokens != null && (
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
                            seg.kind === "tool" ? (
                                <ToolRow key={seg.tool.id} tool={seg.tool} defaultExpanded />
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
                {(onRegenerate || (onRewindFiles && msg.uuid) || onEditResend || canCopy) && !editing && (
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
                        {onRegenerate && msg.role === "assistant" && (
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
