import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown,
    faArrowUp,
    faCircleExclamation,
    faClockRotateLeft,
    faShield,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {ChatCallbacks, ChatNotice, ImagePayload} from "../../hooks/useClaudeChat";
import {useClaudeChat} from "../../hooks/useClaudeChat";
import {MessageItem} from "./MessageItem";
import {ChatInput} from "./ChatInput";
import {ActivityPanel, middleTruncate} from "./ActivityPanel";
import {QuestionModal} from "./QuestionModal";

const cx = classNames.bind(styles);

// "답변 처음으로" 버튼: 화면 맨 위에 걸친 Claude 답변의 시작이 이만큼 넘게 위로 가려져 있고,
// 그 답변이 아래로 이만큼은 더 보일 때만 띄운다 (거의 다 지나간 답변·살짝 가려진 머리줄에는 안 띄운다)
const JUMP_HIDDEN_PX = 48;
const JUMP_REMAINING_PX = 40;
// 답변 머리줄을 화면 맨 위에서 이만큼 띄워 둔다
const JUMP_MARGIN_PX = 12;

// 탭에 저장된 대화를 채워 넣으라는 요청 — token이 바뀔 때마다 한 번
export interface TabLoadRequest {
    token: number;
    messages: LoadedMessage[];
    notice?: ChatNotice | null;
}

// 탭 바깥(헤더·작업 폴더 줄)에서 이 탭에 시키는 것
export interface TabViewApi {
    setNotice: (notice: ChatNotice | null) => void;
    respondPermission: (allow: boolean, always?: boolean) => void;
    stop: () => void;
}

interface RewindState {
    uuid: string;
    loading: boolean;
    preview: RewindFilesResult | null;
    done: RewindFilesResult | null;
}

interface Props {
    tabId: string;
    // 보고 있는 탭만 보인다. 나머지는 숨긴 채 계속 응답을 받는다(입력·스크롤 위치도 그대로).
    active: boolean;
    cwd: string;
    // 실행 중인 백그라운드 작업 수 — 재생성·편집하면 CLI를 새로 띄워 작업이 끝나서 먼저 묻는다
    backgroundRunning: number;
    load: TabLoadRequest | null;
    // 바뀌면 화면을 새 대화로 비운다 (main 쪽은 이미 비웠다 — 폴더 변경, 대화 삭제)
    resetToken: number;
    callbacks: ChatCallbacks;
    registerApi: (tabId: string, api: TabViewApi | null) => void;
}

// 탭 하나의 대화 화면: 메시지·알림·진행 패널·입력창, 그리고 이 탭의 모달(권한·질문·되돌리기·이미지)
function ChatTabViewBase({tabId, active, cwd, backgroundRunning, load, resetToken, callbacks, registerApi}: Props) {
    const {
        messages,
        isLoading,
        isThinking,
        permissionRequest,
        questionRequest,
        thinkingText,
        tools,
        elapsedMs,
        runningTokens,
        notice,
        setNotice,
        turnEnd,
        send,
        regenerate,
        editAndResend,
        respondPermission,
        answerQuestions,
        stopGeneration,
        resetLocal,
        loadSession,
    } = useClaudeChat(tabId, callbacks);

    const [rewind, setRewind] = useState<RewindState | null>(null);
    const [showScrollBottom, setShowScrollBottom] = useState(false);
    // 지금 읽고 있는(화면 맨 위에 걸친) Claude 답변 — 시작이 위로 가려져 있을 때만 값이 있다
    const [jumpTargetId, setJumpTargetId] = useState<number | null>(null);
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    // 다른 대화로 바뀔 때마다 올린다 — 입력창이 대기 중인 메시지를 새 대화로 보내지 않게
    const [conversationSeq, setConversationSeq] = useState(0);
    const messageListRef = useRef<HTMLDivElement>(null);
    const isAtBottomRef = useRef(true);
    // 숨겼다 다시 보일 때 되돌릴 스크롤 위치
    const scrollTopRef = useRef(0);

    // 화면 맨 위 경계에 걸친 메시지를 찾아(메시지는 위에서 아래 순서라 이진 탐색), 그게 시작이 가려진
    // Claude 답변이면 "답변 처음으로" 대상으로 둔다. 스크롤 이벤트는 한 프레임에 한 번이라 바로 잰다.
    const updateJumpTarget = useCallback(() => {
        const list = messageListRef.current;
        if (!list) return;
        const items = list.querySelectorAll<HTMLElement>(":scope > [data-msg-id]");
        const listTop = list.getBoundingClientRect().top;
        let lo = 0;
        let hi = items.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (items[mid].getBoundingClientRect().bottom > listTop) {
                found = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        let next: number | null = null;
        if (found >= 0) {
            const item = items[found];
            const r = item.getBoundingClientRect();
            if (item.dataset.role === "assistant" && r.top < listTop - JUMP_HIDDEN_PX && r.bottom > listTop + JUMP_REMAINING_PX) {
                next = Number(item.dataset.msgId);
            }
        }
        setJumpTargetId((prev) => (prev === next ? prev : next));
    }, []);

    // 탭 바깥에서 쓰는 기능을 등록한다
    useEffect(() => {
        registerApi(tabId, {setNotice, respondPermission, stop: stopGeneration});
    }, [registerApi, tabId, setNotice, respondPermission, stopGeneration]);
    useEffect(() => () => registerApi(tabId, null), [registerApi, tabId]);

    // 저장된 대화 채우기 (사이드바에서 열기, 앱 재시작 후 복원)
    const appliedLoadRef = useRef(0);
    useEffect(() => {
        if (!load || load.token === appliedLoadRef.current) return;
        appliedLoadRef.current = load.token;
        loadSession(load.messages);
        if (load.notice) setNotice(load.notice);
        setConversationSeq((n) => n + 1);
        isAtBottomRef.current = true;
    }, [load, loadSession, setNotice]);

    // 새 대화로 비우기
    const appliedResetRef = useRef(resetToken);
    useEffect(() => {
        if (resetToken === appliedResetRef.current) return;
        appliedResetRef.current = resetToken;
        resetLocal();
        setRewind(null);
        setConversationSeq((n) => n + 1);
        isAtBottomRef.current = true;
    }, [resetToken, resetLocal]);

    useEffect(() => {
        const el = messageListRef.current;
        if (el && isAtBottomRef.current) el.scrollTop = el.scrollHeight;
        // 스크롤 이벤트는 배치가 끝나기 전에 올 수 있다(대화를 막 불러왔을 때) — 내용이 바뀌면 다시 잰다
        updateJumpTarget();
    }, [messages, updateJumpTarget]);

    // 다시 보이게 되면 바닥을 따라가던 탭은 바닥으로, 아니면 보던 자리로
    useLayoutEffect(() => {
        if (!active) return;
        const el = messageListRef.current;
        if (!el) return;
        el.scrollTop = isAtBottomRef.current ? el.scrollHeight : scrollTopRef.current;
        updateJumpTarget();
    }, [active, updateJumpTarget]);

    useEffect(() => {
        if (!lightboxSrc) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setLightboxSrc(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [lightboxSrc]);

    // 재생성·편집은 세션을 이어갈 지점이 바뀌어 CLI를 새로 띄운다 — 백그라운드 작업도 종료된다
    const confirmStopBackground = (action: string) =>
        backgroundRunning === 0 ||
        window.confirm(`백그라운드 작업 ${backgroundRunning}개가 실행 중입니다.\n${action} 이 작업들이 종료됩니다. 계속할까요?`);

    const handleRegenerate = () => {
        if (confirmStopBackground("다시 생성하면")) regenerate();
    };

    const handleEditResend = (text: string) => {
        if (confirmStopBackground("편집해서 다시 보내면")) editAndResend(text);
    };

    const handleMessageScroll = () => {
        const el = messageListRef.current;
        if (!el) return;
        scrollTopRef.current = el.scrollTop;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // 바닥 근처면 다시 따라가고, 충분히 위로 올라가면 따라가기 해제.
        // 자동 스크롤은 항상 바닥(거리≈0)에 닿으므로 이 판정이 자동 스크롤을 오해하지 않는다.
        if (distanceFromBottom < 20) isAtBottomRef.current = true;
        else if (distanceFromBottom > 80) isAtBottomRef.current = false;
        setShowScrollBottom(distanceFromBottom > 80);
        updateJumpTarget();
    };

    // 지금 읽는 답변의 첫 줄(머리줄)로 — 따라가기는 풀린다(위로 가므로)
    const jumpToReplyStart = () => {
        const list = messageListRef.current;
        if (!list || jumpTargetId == null) return;
        const item = list.querySelector<HTMLElement>(`:scope > [data-msg-id="${jumpTargetId}"]`);
        if (!item) return;
        isAtBottomRef.current = false;
        const top = list.scrollTop + item.getBoundingClientRect().top - list.getBoundingClientRect().top - JUMP_MARGIN_PX;
        list.scrollTo({top: Math.max(0, top), behavior: "smooth"});
    };

    // 위로 스크롤(휠/트랙패드)하면 즉시 따라가기 해제 — 읽는 도중 끌려 내려가지 않게
    const handleMessageWheel = (e: React.WheelEvent) => {
        if (e.deltaY < 0) isAtBottomRef.current = false;
    };

    const scrollToBottom = () => {
        const el = messageListRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        isAtBottomRef.current = true;
        setShowScrollBottom(false);
    };

    // 먼저 미리보기(dryRun)로 무엇이 바뀌는지 보여주고, 확인을 받은 뒤 되돌린다
    const handleRewindFiles = useCallback(
        async (uuid: string) => {
            setRewind({uuid, loading: true, preview: null, done: null});
            const preview = await window.electronAPI.rewindFiles(tabId, uuid, true);
            setRewind((cur) => (cur?.uuid === uuid ? {...cur, loading: false, preview} : cur));
        },
        [tabId]
    );

    const confirmRewind = async () => {
        if (!rewind) return;
        const uuid = rewind.uuid;
        setRewind({...rewind, loading: true});
        const done = await window.electronAPI.rewindFiles(tabId, uuid, false);
        setRewind((cur) => (cur?.uuid === uuid ? {...cur, loading: false, done} : cur));
    };

    const handleSend = useCallback(
        (text: string, images: ImagePayload[]) => {
            send(text, images);
            isAtBottomRef.current = true;
        },
        [send]
    );

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");

    return (
        <div className={cx("tabView", {tabViewHidden: !active})} aria-hidden={!active}>
            {/* 채팅 영역 */}
            <div className={cx("messageListWrap")}>
                <div
                    className={cx("messageList")}
                    ref={messageListRef}
                    onScroll={handleMessageScroll}
                    onWheel={handleMessageWheel}
                >
                    {messages.map((msg, i) => (
                        <MessageItem
                            key={msg.id}
                            msg={msg}
                            isStreaming={isThinking && i === messages.length - 1}
                            onImageClick={setLightboxSrc}
                            onRegenerate={
                                !isLoading && i === messages.length - 1 && msg.role === "assistant" && lastUserIdx >= 0
                                    ? handleRegenerate
                                    : undefined
                            }
                            onEditResend={!isLoading && i === lastUserIdx ? handleEditResend : undefined}
                            onRewindFiles={!isLoading ? handleRewindFiles : undefined}
                        />
                    ))}
                    {notice && (
                        <div className={cx("notice", notice.level === "error" ? "noticeError" : "noticeWarning")}>
                            <FontAwesomeIcon
                                icon={notice.level === "error" ? faCircleExclamation : faTriangleExclamation}
                                className={cx("noticeIcon")}
                            />
                            <div className={cx("noticeBody")}>
                                <div className={cx("noticeMessage")}>{notice.message}</div>
                                {notice.detail && notice.detail !== notice.message && (
                                    <details className={cx("noticeDetails")}>
                                        <summary className={cx("noticeSummary")}>자세히</summary>
                                        <pre className={cx("noticeDetail")}>{notice.detail}</pre>
                                    </details>
                                )}
                            </div>
                            <button className={cx("noticeClose")} onClick={() => setNotice(null)} aria-label="닫기">
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>
                    )}
                </div>
                {/* 긴 답변을 읽다가(또는 다 읽고) 그 답변의 처음으로 */}
                <button
                    className={cx("jumpReplyButton", {visible: jumpTargetId != null})}
                    onClick={jumpToReplyStart}
                    aria-label="이 답변의 처음으로"
                    tabIndex={jumpTargetId != null ? 0 : -1}
                >
                    <FontAwesomeIcon icon={faArrowUp} />
                    답변 처음으로
                </button>
                <button
                    className={cx("scrollBottomButton", {visible: showScrollBottom})}
                    onClick={scrollToBottom}
                    data-tooltip="맨 아래로"
                    aria-label="맨 아래로"
                >
                    <FontAwesomeIcon icon={faArrowDown} />
                </button>
            </div>

            {/* 활동 패널 */}
            {isLoading && (
                <ActivityPanel
                    isThinking={isThinking}
                    tools={tools}
                    thinkingText={thinkingText}
                    elapsedMs={elapsedMs}
                    runningTokens={runningTokens}
                />
            )}

            {/* 입력 영역 */}
            <ChatInput
                tabId={tabId}
                active={active}
                isLoading={isLoading}
                onSend={handleSend}
                onStop={stopGeneration}
                turnEnd={turnEnd}
                resetSignal={conversationSeq}
            />

            {/* 이미지 라이트박스 */}
            {lightboxSrc && (
                <div className={cx("lightboxOverlay")} onClick={() => setLightboxSrc(null)}>
                    <button className={cx("lightboxClose")} onClick={() => setLightboxSrc(null)} aria-label="닫기">
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                    <img src={lightboxSrc} className={cx("lightboxImage")} alt="" onClick={(e) => e.stopPropagation()} />
                </div>
            )}

            {/* Claude의 선택지 질문 (AskUserQuestion) */}
            {questionRequest && (
                <QuestionModal
                    questions={questionRequest.questions}
                    onAnswer={answerQuestions}
                    onSkip={() => answerQuestions(questionRequest.questions.map(() => []))}
                />
            )}

            {/* 파일 되돌리기 확인 */}
            {rewind && (
                <>
                    <div className={cx("modalOverlay")} onClick={() => !rewind.loading && setRewind(null)} />
                    <div className={cx("modal", "modalWide")}>
                        <div className={cx("modalIcon")}>
                            <FontAwesomeIcon icon={faClockRotateLeft} />
                        </div>
                        <h3 className={cx("modalTitle")}>
                            {rewind.done ? "파일 되돌리기 결과" : "이 메시지 이전으로 파일 되돌리기"}
                        </h3>
                        {rewind.loading && <p className={cx("modalDesc")}>확인하는 중…</p>}
                        {!rewind.loading && rewind.done && (
                            <p className={cx("modalDesc")}>
                                {rewind.done.canRewind
                                    ? `파일 ${rewind.preview?.filesChanged?.length ?? 0}개를 되돌렸습니다. 대화는 그대로라 Claude는 이 사실을 모릅니다. 이어서 작업하려면 Claude에게 알려 주세요.`
                                    : `되돌리지 못했습니다: ${rewind.done.error ?? "알 수 없는 오류"}`}
                            </p>
                        )}
                        {!rewind.loading && !rewind.done && rewind.preview && (
                            rewind.preview.canRewind && (rewind.preview.filesChanged?.length ?? 0) > 0 ? (
                                <>
                                    <p className={cx("modalDesc")}>
                                        아래 파일이 이 메시지를 보내기 직전 상태로 돌아갑니다
                                        {` (+${rewind.preview.insertions ?? 0} −${rewind.preview.deletions ?? 0})`}.
                                    </p>
                                    <div className={cx("rewindFileList")}>
                                        {rewind.preview.filesChanged?.map((f) => {
                                            const rel = cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f;
                                            return (
                                                <code key={f} className={cx("rewindFile")} title={f}>
                                                    {middleTruncate(rel, 70)}
                                                </code>
                                            );
                                        })}
                                    </div>
                                    <ul className={cx("rewindNote")}>
                                        <li>Write·Edit 도구로 바꾼 파일만 되돌립니다. Bash 명령으로 만들거나 고친 파일은 그대로 남습니다.</li>
                                        <li>대화는 그대로라 Claude는 파일이 되돌려진 걸 모릅니다. 이어서 작업하려면 Claude에게 알려 주세요.</li>
                                    </ul>
                                </>
                            ) : (
                                <p className={cx("modalDesc")}>
                                    {rewind.preview.canRewind
                                        ? "이 메시지 이후 Claude가 Write·Edit 도구로 바꾼 파일이 없습니다. Bash 명령으로 바꾼 파일은 되돌릴 수 없습니다."
                                        : `되돌릴 수 없습니다: ${rewind.preview.error ?? "알 수 없는 오류"}`}
                                </p>
                            )
                        )}
                        <div className={cx("modalActions")}>
                            <button className={cx("modalBtn", "deny")} onClick={() => setRewind(null)} disabled={rewind.loading}>
                                {rewind.done || !rewind.preview?.filesChanged?.length ? "닫기" : "취소"}
                            </button>
                            {!rewind.done && rewind.preview?.canRewind && (rewind.preview.filesChanged?.length ?? 0) > 0 && (
                                <button className={cx("modalBtn", "allow")} onClick={confirmRewind} disabled={rewind.loading}>
                                    되돌리기
                                </button>
                            )}
                        </div>
                    </div>
                </>
            )}

            {/* 권한 요청 팝업 */}
            {permissionRequest && (
                <>
                    {/* 바깥을 눌러도 거부로 답한다 — 답을 안 보내면 CLI가 계속 멈춰 있다 */}
                    <div className={cx("modalOverlay")} onClick={() => respondPermission(false)} />
                    <div className={cx("modal", "modalWide")}>
                        <div className={cx("modalIcon")}>
                            <FontAwesomeIcon icon={faShield} />
                        </div>
                        <h3 className={cx("modalTitle")}>
                            {permissionRequest.title ??
                                `${permissionRequest.displayName ?? permissionRequest.toolName} 실행을 허용할까요?`}
                        </h3>
                        {permissionRequest.decisionReason && (
                            <p className={cx("modalDesc")}>{permissionRequest.decisionReason}</p>
                        )}
                        {permissionRequest.target && <code className={cx("modalPath")}>{permissionRequest.target}</code>}
                        <div className={cx("modalActions")}>
                            <button className={cx("modalBtn", "deny")} onClick={() => respondPermission(false)}>
                                거부
                            </button>
                            <button className={cx("modalBtn", "allow")} onClick={() => respondPermission(true)}>
                                허용
                            </button>
                        </div>
                        {permissionRequest.alwaysAllow && permissionRequest.alwaysAllow.length > 0 && (
                            <button
                                className={cx("modalAlwaysBtn")}
                                onClick={() => respondPermission(true, true)}
                                title={permissionRequest.alwaysAllow.join("\n")}
                            >
                                이 대화에서 항상 허용
                                <span className={cx("modalAlwaysRule")}>
                                    {middleTruncate(permissionRequest.alwaysAllow.join(", "), 80)}
                                </span>
                            </button>
                        )}
                        {permissionRequest.alwaysAllow && permissionRequest.alwaysAllow.length > 0 && (
                            <p className={cx("modalAlwaysHint")}>
                                다른 대화를 열었다 돌아와도 유지되고, 앱을 다시 켜면 다시 물어봅니다.
                            </p>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export const ChatTabView = memo(ChatTabViewBase);
