import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown,
    faArrowUp,
    faCircleExclamation,
    faClockRotateLeft,
    faPaperclip,
    faShield,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {ChatCallbacks, ChatNotice, ImagePayload, ToolActivity} from "../../hooks/useClaudeChat";
import {useClaudeChat} from "../../hooks/useClaudeChat";
import {MessageItem} from "./MessageItem";
import {ChatInput, type PromptHooks} from "./ChatInput";
import {FindBar} from "./FindBar";
import {
    type BackgroundLink,
    type BackgroundLinks,
    BackgroundLinksContext,
    ImageViewerContext,
    PreviewOpenContext,
    type PreviewRequest,
    TabIdContext,
} from "../../tab-context";
import {BackgroundDock} from "./BackgroundDock";
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
    // ⌘F / ⌘G / ⇧⌘G (앱 메뉴)
    openFind: () => void;
    findStep: (dir: 1 | -1) => void;
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
    // 이 탭의 백그라운드 작업(실행 중 + 최근 끝난 것) — 입력창 위 작업 줄, 답변 속 실행 줄의 상태.
    // 실행 중인 게 있으면 재생성·편집 전에 묻는다(CLI를 새로 띄워 작업이 끝난다).
    background: BackgroundState;
    // 오른쪽 백그라운드 패널이 이 탭으로 열려 있나, 열려 있으면 어느 작업을 보고 있나 (패널은 셸이 그린다)
    bgPanelOpen: boolean;
    bgPanelTaskId: string | null;
    onOpenBackground: (tabId: string, taskId: string | null) => void;
    onCloseBackground: () => void;
    load: TabLoadRequest | null;
    // 바뀌면 화면을 새 대화로 비운다 (main 쪽은 이미 비웠다 — 폴더 변경, 대화 삭제)
    resetToken: number;
    callbacks: ChatCallbacks;
    registerApi: (tabId: string, api: TabViewApi | null) => void;
    // 시스템 프롬프트를 바꾸기 전 확인·바꾼 뒤 안내 (모든 탭에 적용되므로 셸이 맡는다)
    promptHooks: PromptHooks;
    // "여기까지 새 탭으로"로 갈라낸 대화를 이 탭 옆 새 탭으로 연다 (탭 목록은 셸이 가진다)
    onFork: (fromTabId: string, sessionId: string, title: string, cwd: string) => void;
    // 에이전트 줄을 누르면 오른쪽 "에이전트가 한 일" 패널 (패널은 셸이 그린다)
    onOpenAgent: (tabId: string, ref: AgentRef) => void;
    // HTML·SVG 미리보기를 오른쪽 패널에 크게 (패널은 셸이 그린다)
    onOpenPreview: (tabId: string, req: PreviewRequest) => void;
}

// 탭 하나의 대화 화면: 메시지·알림·진행 패널·입력창, 그리고 이 탭의 모달(권한·질문·되돌리기·이미지)
function ChatTabViewBase({
    tabId,
    active,
    cwd,
    background,
    bgPanelOpen,
    bgPanelTaskId,
    onOpenBackground,
    onCloseBackground,
    load,
    resetToken,
    callbacks,
    registerApi,
    promptHooks,
    onFork,
    onOpenAgent,
    onOpenPreview,
}: Props) {
    const {
        messages,
        isLoading,
        isThinking,
        compacting,
        suggestion,
        clearSuggestion,
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
        rewriteFrom,
        respondPermission,
        answerQuestions,
        stopGeneration,
        resetLocal,
        loadSession,
    } = useClaudeChat(tabId, callbacks);

    const [rewind, setRewind] = useState<RewindState | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    // 파일을 탭 화면 어디에 끌어다 놓아도 입력창에 붙인다 (스크린샷을 대화 영역에 놓는 일이 많다)
    const [dragging, setDragging] = useState(false);
    const dragDepthRef = useRef(0);
    const addFilesRef = useRef<((files: File[]) => void) | null>(null);
    const registerAddFiles = useCallback((add: ((files: File[]) => void) | null) => {
        addFilesRef.current = add;
    }, []);
    // 글자·링크를 끄는 건 받지 않는다 — 파일만
    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
    const dragHandlers = {
        onDragEnter: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepthRef.current += 1;
            setDragging(true);
        },
        // 안쪽 요소로 옮겨 갈 때도 leave가 온다 — 들어온 횟수를 세어 바깥으로 완전히 나갔을 때만 끈다
        onDragLeave: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDragging(false);
        },
        onDragOver: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        },
        onDrop: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepthRef.current = 0;
            setDragging(false);
            addFilesRef.current?.(Array.from(e.dataTransfer.files));
        },
    };
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

    // ⌘F 찾기 (FindBar.tsx) — 탭마다 따로 열고, 검색어도 탭마다 남는다
    const [findOpen, setFindOpen] = useState(false);
    const [findFocusSeq, setFindFocusSeq] = useState(0);
    const [findStepReq, setFindStepReq] = useState<{dir: 1 | -1; seq: number} | null>(null);
    const findStepSeqRef = useRef(0);
    const openFind = useCallback(() => {
        setFindOpen(true);
        setFindFocusSeq((n) => n + 1);
    }, []);
    const findStep = useCallback((dir: 1 | -1) => {
        setFindOpen(true);
        setFindStepReq({dir, seq: ++findStepSeqRef.current});
    }, []);
    const closeFind = useCallback(() => {
        setFindOpen(false);
        // 찾기를 닫으면 입력창으로 돌아간다
        rootRef.current?.querySelector<HTMLTextAreaElement>("[data-chat-input]")?.focus();
    }, []);
    // 찾은 곳으로 넘기면 맨 아래 따라가기를 푼다 — 응답이 흘러 들어와도 끌려 내려가지 않게
    const releaseFollow = useCallback(() => {
        isAtBottomRef.current = false;
    }, []);

    // 탭 바깥에서 쓰는 기능을 등록한다
    useEffect(() => {
        registerApi(tabId, {setNotice, respondPermission, stop: stopGeneration, openFind, findStep});
    }, [registerApi, tabId, setNotice, respondPermission, stopGeneration, openFind, findStep]);
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

    // ── 여기서 다시 / 여기까지 새 탭으로 ──
    // 메시지마다 넘기는 함수라 한 번만 만든다(MessageItem은 memo) — 바뀌는 값은 ref로 읽는다.
    const latest = useRef({rewriteFrom, confirmStopBackground, onFork, setNotice});
    latest.current = {rewriteFrom, confirmStopBackground, onFork, setNotice};
    const handleRewrite = useCallback(
        async (msgId: number, uuid: string, text: string, withFiles: boolean) => {
            const l = latest.current;
            if (!l.confirmStopBackground("여기서 다시 시작하면")) return;
            if (withFiles) {
                // 파일은 대화보다 먼저 — 첫 메시지부터 다시 쓰면 새 대화가 생기고 옛 대화(파일 기록 포함)는 지워진다
                const r = await window.electronAPI.rewindFiles(tabId, uuid, false);
                if (!r.canRewind && !window.confirm(`파일을 되돌리지 못했습니다: ${r.error ?? "알 수 없는 오류"}\n대화만 여기서 다시 시작할까요?`)) {
                    return;
                }
            }
            isAtBottomRef.current = true;
            latest.current.rewriteFrom(msgId, text);
        },
        [tabId]
    );
    const [forkingUuid, setForkingUuid] = useState<string | null>(null);
    const handleFork = useCallback(
        async (replyUuid: string) => {
            setForkingUuid(replyUuid);
            const r = await window.electronAPI.forkConversation(tabId, replyUuid);
            setForkingUuid(null);
            if (r.ok === false) {
                latest.current.setNotice({level: "warning", message: "새 탭으로 갈라내지 못했습니다", detail: r.error});
                return;
            }
            latest.current.onFork(tabId, r.sessionId, r.title, r.cwd);
        },
        [tabId]
    );
    // 에이전트 줄 → 그 에이전트가 한 일 (호출 입력의 종류·설명은 패널 머리에 쓴다)
    const openAgentFromTool = useCallback(
        (tool: ToolActivity) => {
            const input = (tool.input ?? {}) as {subagent_type?: unknown; description?: unknown};
            onOpenAgent(tabId, {
                toolUseId: tool.id,
                agentType: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
                description: typeof input.description === "string" ? input.description : undefined,
            });
        },
        [onOpenAgent, tabId]
    );
    const openPreview = useCallback((req: PreviewRequest) => onOpenPreview(tabId, req), [onOpenPreview, tabId]);
    const backgroundRunning = background.running.length;
    const openBackground = useCallback((taskId: string | null) => onOpenBackground(tabId, taskId), [onOpenBackground, tabId]);
    // 답변 속 도구 줄 → 그 줄이 띄운 작업. 끝난 기록을 먼저 넣는다 — 끝나는 순간엔 실행 중 목록에도 잠깐 남아 있다.
    const bgLinks = useMemo<BackgroundLinks>(() => {
        const byToolUse = new Map<string, BackgroundLink>();
        for (const f of background.finished) {
            if (f.toolUseId) {
                byToolUse.set(f.toolUseId, {
                    taskId: f.id,
                    running: false,
                    startedAt: f.startedAt,
                    endedAt: f.endedAt,
                    status: f.status,
                    exitCode: f.exitCode,
                });
            }
        }
        for (const t of background.running) {
            if (t.toolUseId && !byToolUse.has(t.toolUseId)) byToolUse.set(t.toolUseId, {taskId: t.id, running: true, startedAt: t.startedAt});
        }
        return {byToolUse, open: (id) => openBackground(id)};
    }, [background, openBackground]);
    // 고치는 중인 메시지 — 그 아래 메시지를 흐리게 그려 무엇이 버려지는지 보여 준다
    const [editingId, setEditingId] = useState<number | null>(null);
    const handleEditingChange = useCallback((msgId: number, editing: boolean) => {
        setEditingId((cur) => (editing ? msgId : cur === msgId ? null : cur));
    }, []);

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
    // 마지막으로 대화를 요약한 답변 — 그 앞 메시지는 기록이 요약으로 바뀌어 되돌리거나 갈라낼 수 없다
    const lastCompactIdx = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].segments?.some((sg) => sg.kind === "compact")) return i;
        return -1;
    }, [messages]);
    const editingIdx = editingId === null ? -1 : messages.findIndex((m) => m.id === editingId);

    return (
        <BackgroundLinksContext.Provider value={bgLinks}>
        <div className={cx("tabView", {tabViewHidden: !active})} aria-hidden={!active} ref={rootRef} {...dragHandlers}>
            {dragging && (
                <div className={cx("dragOverlay")}>
                    <FontAwesomeIcon icon={faPaperclip} />
                    <span>여기에 놓으면 메시지에 첨부합니다</span>
                </div>
            )}
            {/* 채팅 영역 */}
            <div className={cx("messageListWrap")}>
                <TabIdContext.Provider value={tabId}>
                <ImageViewerContext.Provider value={setLightboxSrc}>
                <PreviewOpenContext.Provider value={openPreview}>
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
                                isLive={isLoading && i === messages.length - 1}
                                onImageClick={setLightboxSrc}
                                onRegenerate={
                                    !isLoading && i === messages.length - 1 && msg.role === "assistant" && lastUserIdx >= 0
                                        ? handleRegenerate
                                        : undefined
                                }
                                onEditResend={!isLoading && i === lastUserIdx ? handleEditResend : undefined}
                                onRewindFiles={!isLoading ? handleRewindFiles : undefined}
                                onRewrite={!isLoading && i < lastUserIdx && i > lastCompactIdx ? handleRewrite : undefined}
                                belowCount={messages.length - i - 1}
                                onFork={!isLoading && i >= lastCompactIdx ? handleFork : undefined}
                                forking={!!msg.replyUuid && forkingUuid === msg.replyUuid}
                                onEditingChange={handleEditingChange}
                                dimmed={editingIdx >= 0 && i > editingIdx}
                                onOpenAgent={openAgentFromTool}
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
                </PreviewOpenContext.Provider>
                </ImageViewerContext.Provider>
                </TabIdContext.Provider>
                {findOpen && (
                    <FindBar
                        listRef={messageListRef}
                        active={active}
                        contentKey={messages}
                        focusSeq={findFocusSeq}
                        step={findStepReq}
                        onClose={closeFind}
                        onJump={releaseFollow}
                    />
                )}
                {/* 긴 답변을 읽다가(또는 다 읽고) 그 답변의 처음으로 */}
                <button
                    className={cx("jumpReplyButton", {visible: jumpTargetId != null, jumpReplyButtonLow: findOpen})}
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
                    compacting={compacting}
                    onOpenAgent={openAgentFromTool}
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
                promptHooks={promptHooks}
                onRegisterAddFiles={registerAddFiles}
                suggestion={suggestion}
                onSuggestionUsed={clearSuggestion}
                top={
                    <BackgroundDock
                        tabId={tabId}
                        active={active}
                        state={background}
                        panelOpen={bgPanelOpen}
                        panelTaskId={bgPanelTaskId}
                        onOpen={openBackground}
                        onClosePanel={onCloseBackground}
                    />
                }
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
        </BackgroundLinksContext.Provider>
    );
}

export const ChatTabView = memo(ChatTabViewBase);
