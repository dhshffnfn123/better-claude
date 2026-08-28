import {memo, useEffect, useState} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faClockRotateLeft, faPen, faRotateRight} from "@fortawesome/free-solid-svg-icons";
import claudeIcon from "../../assets/better-claude-icon.png";
import styles from "./chat.page.module.scss";
import type {Message} from "../../hooks/useClaudeChat";
import {ToolRow} from "./ActivityPanel";

const cx = classNames.bind(styles);

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
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
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
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        )}
                    </div>
                )}
                {(onRegenerate || (onRewindFiles && msg.uuid) || onEditResend) && !editing && (
                    <div className={cx("msgActions")}>
                        {onEditResend && !editing && msg.role === "user" && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => {
                                    setDraft(msg.content);
                                    setEditing(true);
                                }}
                            >
                                <FontAwesomeIcon icon={faPen} /> 편집
                            </button>
                        )}
                        {onRewindFiles && msg.uuid && msg.role === "user" && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => msg.uuid && onRewindFiles(msg.uuid)}
                                title="이 메시지를 보내기 직전 상태로 Claude가 수정한 파일을 되돌립니다 (대화는 그대로)"
                            >
                                <FontAwesomeIcon icon={faClockRotateLeft} /> 파일 되돌리기
                            </button>
                        )}
                        {onRegenerate && msg.role === "assistant" && (
                            <button className={cx("msgActionBtn")} onClick={onRegenerate}>
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
