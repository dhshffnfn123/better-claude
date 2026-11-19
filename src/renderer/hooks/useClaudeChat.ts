import { useCallback, useEffect, useRef, useState } from "react";
import {onTab} from "../tab-events";

export interface ImagePayload {
    previewUrl: string;
    data: string;      // base64
    mediaType: string;
    name?: string; // 파일 이름 — 보내기 전 크게 보기에 보인다 (main으로는 data·mediaType만 간다)
}

export async function readFileAsImagePayload(file: File): Promise<ImagePayload> {
    const previewUrl = URL.createObjectURL(file);
    const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
    return { previewUrl, data, mediaType: file.type || "image/png", name: file.name || undefined };
}

export interface Message {
    id: number;
    uuid?: string; // 사용자 메시지: CLI에 보낸 uuid (파일 되돌리기 기준점)
    role: "user" | "assistant";
    content: string;
    images?: string[]; // 미리보기용 object URL
    inputTokens?: number;
    outputTokens?: number;
    segments?: MessageSegment[]; // 어시스턴트: 텍스트/도구를 발생 순서대로 보관
    greeting?: boolean; // 새 대화의 첫 인사말 (복사 버튼 등을 붙이지 않는다)
    replyUuid?: string; // 답변: 그 답변의 마지막 기록 항목 — "여기까지 새 탭으로"의 지점
    copied?: boolean; // 갈라낸 대화로 복사된 메시지 — 파일 되돌리기 기록이 없다
    // 사용자 메시지에 붙여 보낸 그림 원본 — "여기서 다시"로 다시 보낼 때 쓴다 (미리보기 URL로는 다시 못 보낸다)
    imagePayloads?: {data: string; mediaType: string}[];
}

// 다시 보낼 그림: 보낼 때 남겨 둔 원본, 없으면(불러온 대화) data URL 미리보기를 풀어서
function resendableImages(msg: Message): {data: string; mediaType: string}[] {
    if (msg.imagePayloads) return msg.imagePayloads;
    return (msg.images ?? []).flatMap((url) => {
        const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
        return m ? [{mediaType: m[1], data: m[2]}] : [];
    });
}

export interface ToolActivity {
    id: string;
    name: string;
    input: unknown;
    status: "running" | "done" | "error";
    resultPreview?: string;
    // 서브에이전트(Agent 도구)가 쓴 도구면 그 Agent 호출의 id
    parentToolUseId?: string;
    images?: string[]; // 도구 결과에 든 그림 (Read로 연 그림, 스크린샷 등 — data URL)
    imagesOmitted?: number; // 불러온 대화에서 오래돼 싣지 않은 그림 수
    startedAt?: number; // 도구를 부른 시각 — 이 도구가 만든 그림을 파일 수정 시각으로 가려낸다
    resultLinks?: string[]; // 도구 결과에 나온 Figma 파일 주소 (main이 결과 글 전체에서 찾는다 — 미리보기는 앞부분뿐)
}

export type CompactSegment = {kind: "compact"} & CompactInfo;

export type MessageSegment =
    | {kind: "text"; text: string}
    | {kind: "tool"; tool: ToolActivity}
    | CompactSegment;

// 대화 압축 중 — manual: 사용자가 보낸 /compact, auto: 컨텍스트가 차서 CLI가 스스로
export type Compacting = "manual" | "auto" | null;

const COMPACT_COMMAND_RE = /^\/compact(\s|$)/;

export interface PermissionRequest {
    id: string;
    /** "이 대화에서 항상 허용"을 고르면 허용되는 규칙들 */
    alwaysAllow?: string[];
    toolName: string;
    /** CLI가 만들어 준 문장 (예: "Claude wants to read foo.txt") */
    title?: string;
    /** 짧은 동작 이름 (예: "Read file") */
    displayName?: string;
    blockedPath?: string;
    decisionReason?: string;
    /** 대상 경로나 명령 — 모달에 무엇에 대한 요청인지 보여준다 */
    target?: string;
    input: unknown;
}

export interface QuestionRequest {
    id: string;
    questions: AskQuestion[];
}

// info: 앱이 처리한 슬래시 명령의 결과 (/model haiku → "모델을 … 바꿨습니다") — main은 error·warning만 보낸다
export interface ChatNotice {
    level: "error" | "warning" | "info";
    message: string;
    detail?: string;
}

export interface RunningTokens {
    input: number;
    output: number;
}

// 턴이 끝날 때마다 seq가 오른다. stopped = 사용자가 중지해서 끝났다 (입력창의 대기 메시지가 이걸 보고 보낼지 정한다)
export interface TurnEnd {
    seq: number;
    stopped: boolean;
    failed: boolean; // 오류로 끝났다 (사용량 한도·API 오류 등) — 대기 메시지를 보내지 않는다
}

export type Attention = "permission" | "question" | null;

// 탭 바깥(탭 줄·알림)에 알리는 것. 알림을 띄울지는 받는 쪽이 정한다 — 어느 탭을 보고 있는지 알기 때문이다.
export interface ChatCallbacks {
    onLoadingChange?: (loading: boolean) => void;
    // 허용·질문을 기다리기 시작했거나(kind) 끝났다(null). summary는 알림에 넣을 짧은 글.
    onAttention?: (kind: Attention, summary: string) => void;
    onTurnEnd?: (info: {seq: number; stopped: boolean; failed: boolean; summary: string}) => void;
    // 사용자가 메시지를 보냈다 (탭 제목을 정하는 데 쓴다)
    onUserMessage?: (text: string) => void;
}

// 알림에 넣을 짧은 글: 코드 블록·마크다운 기호를 빼고 앞부분만
export function plainSummary(text: string, max = 140): string {
    const plain = text
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_#>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
}

function permissionSummary(req: PermissionRequest): string {
    return `${req.displayName ?? req.toolName}${req.target ? ` · ${req.target}` : ""}`;
}

function questionSummary(req: QuestionRequest): string {
    const first = req.questions[0]?.question ?? "";
    const more = req.questions.length > 1 ? ` 외 ${req.questions.length - 1}개` : "";
    return plainSummary(first) + more;
}

const INITIAL_MESSAGE: Message = {
    id: 1,
    role: "assistant",
    content: "안녕하세요! 무엇을 도와드릴까요?",
    greeting: true,
};

// 탭 하나의 대화. 이벤트는 이 탭 것만 받고(tab-events), main에 보내는 요청에는 탭 id를 싣는다.
// 스트리밍 중 글자 조각을 화면에 반영하는 간격 (초당 20번)
const CHUNK_FLUSH_MS = 50;

export function useClaudeChat(tabId: string, callbacks: ChatCallbacks = {}) {
    const [messages, setMessages] = useState<Message[]>([INITIAL_MESSAGE]);
    const [isLoading, setIsLoading] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
    const [questionRequest, setQuestionRequest] = useState<QuestionRequest | null>(null);
    const [thinkingText, setThinkingText] = useState("");
    const [tools, setTools] = useState<ToolActivity[]>([]);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [runningTokens, setRunningTokens] = useState<RunningTokens>({input: 0, output: 0});
    const [notice, setNotice] = useState<ChatNotice | null>(null);
    const [turnEnd, setTurnEnd] = useState<TurnEnd>({seq: 0, stopped: false, failed: false});
    const [compacting, setCompacting] = useState<Compacting>(null);
    // 답변이 끝난 뒤 CLI가 짐작한 다음 요청 (입력창에 흐리게) — 새 메시지·다른 대화면 지운다
    const [suggestion, setSuggestion] = useState<string | null>(null);
    const loadingRef = useRef(false);
    loadingRef.current = isLoading;
    const idCounter = useRef(2);
    const turnSeqRef = useRef(0);
    const startedAtRef = useRef<number | null>(null);
    const toolsRef = useRef<ToolActivity[]>([]);
    const lastSentRef = useRef<{message: string; images: ImagePayload[]} | null>(null);
    // 진행 중인 턴을 즉시 닫는 함수. 중지 버튼이 main 응답을 기다리지 않고 바로 호출한다.
    const finishRef = useRef<((stopped: boolean) => void) | null>(null);
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;

    useEffect(() => {
        const offRequest = onTab("permissionRequest", tabId, setPermissionRequest);
        const offQuestion = onTab("questionRequest", tabId, setQuestionRequest);
        // 턴이 끝나면 답할 수 없는 요청이 되므로 모달을 닫는다 (id가 null이면 전부)
        const offResolved = onTab("permissionResolved", tabId, ({id}) => {
            setPermissionRequest((cur) => (cur && (id === null || cur.id === id) ? null : cur));
            setQuestionRequest((cur) => (cur && (id === null || cur.id === id) ? null : cur));
        });
        return () => {
            offRequest();
            offQuestion();
            offResolved();
        };
    }, [tabId]);

    // 허용·질문을 기다리는지 탭 바깥에 알린다 (탭 표시, 알림)
    useEffect(() => {
        if (permissionRequest) callbacksRef.current.onAttention?.("permission", permissionSummary(permissionRequest));
        else if (questionRequest) callbacksRef.current.onAttention?.("question", questionSummary(questionRequest));
        else callbacksRef.current.onAttention?.(null, "");
    }, [permissionRequest, questionRequest]);

    useEffect(() => {
        callbacksRef.current.onLoadingChange?.(isLoading);
    }, [isLoading]);

    // 추천은 턴이 끝난 뒤(2~3초)에 와서 턴마다 거는 구독 밖에서 받는다. 그새 다음 메시지를 보냈으면 버린다.
    useEffect(
        () =>
            onTab("suggestion", tabId, ({text}) => {
                if (!loadingRef.current) setSuggestion(text);
            }),
        [tabId]
    );
    const clearSuggestion = useCallback(() => setSuggestion(null), []);

    useEffect(() => {
        if (!isLoading) return;
        const id = window.setInterval(() => {
            if (startedAtRef.current != null) {
                setElapsedMs(Date.now() - startedAtRef.current);
            }
        }, 200);
        return () => window.clearInterval(id);
    }, [isLoading]);

    const nextId = useCallback(() => ++idCounter.current, []);

    // compactCommand: 보낸 메시지가 /compact — 진행 표시 문구만 다르다
    const startResponse = useCallback((apiCall: () => Promise<void>, userId?: number, compactCommand = false) => {
        const assistantId = nextId();

        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setThinkingText("");
        setTools([]);
        toolsRef.current = [];
        setRunningTokens({input: 0, output: 0});
        setNotice(null);
        setCompacting(null);
        setSuggestion(null);

        setIsLoading(true);
        setIsThinking(true);
        setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", segments: [] }]);

        // 텍스트/도구를 발생 순서대로 보관 → 도구 호출 전후 멘트가 한 말풍선에 뒤섞이지 않게 분리.
        const segs: MessageSegment[] = [];
        // 글자 조각은 모아서 그린다(CHUNK_FLUSH_MS) — 조각마다 그리면 긴 답변에서 화면이 무거워졌다(여러 탭이 동시에
        // 답하면 입력이 끊길 만큼). 도구·압축처럼 드문 일은 바로 그리고, 끝날 때 남은 것을 바로 그린다(finish).
        let flushTimer: number | null = null;
        const flush = () => {
            if (flushTimer !== null) {
                window.clearTimeout(flushTimer);
                flushTimer = null;
            }
            const content = segs
                .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
                .map((s) => s.text)
                .join("\n\n");
            // 텍스트 조각은 이어 붙이며 고치므로 복사한다 (도구·압축 조각은 바뀔 때 통째로 바꿔 끼운다)
            const snapshot = segs.map((s) => (s.kind === "text" ? {kind: "text" as const, text: s.text} : s));
            setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content, segments: snapshot } : m))
            );
        };
        const flushSoon = () => {
            if (flushTimer === null) flushTimer = window.setTimeout(flush, CHUNK_FLUSH_MS);
        };

        const removeChunk = onTab("chunk", tabId, (text) => {
            setIsThinking(false);
            const last = segs[segs.length - 1];
            if (last && last.kind === "text") last.text += text;
            else segs.push({ kind: "text", text });
            flushSoon();
        });

        const removeUsage = onTab("usage", tabId, (usage) => {
            setRunningTokens({input: usage.inputTokens, output: usage.outputTokens});
            setMessages((prev) =>
                prev.map((m) => {
                    if (m.id === assistantId) return { ...m, outputTokens: usage.outputTokens };
                    if (userId !== undefined && m.id === userId) return { ...m, inputTokens: usage.inputTokens };
                    return m;
                })
            );
        });

        // 이 답변의 마지막 기록 항목 — 턴이 끝날 때 답변에 붙인다 (그때까지 자주 바뀌어 매번 그리지 않는다)
        let replyUuid: string | undefined;
        const removeReplyUuid = onTab("replyUuid", tabId, ({uuid}) => {
            replyUuid = uuid;
        });

        // 오류로 끝난 턴은 알림 문구를 바꾼다
        let failed: ChatNotice | null = null;
        const removeError = onTab("error", tabId, (n) => {
            setNotice(n);
            if (n.level === "error") failed = n;
        });

        const removeTurnUuid = onTab("turnUuid", tabId, ({uuid}) => {
            if (userId === undefined) return;
            setMessages((prev) => prev.map((m) => (m.id === userId ? {...m, uuid} : m)));
        });

        const removeThinking = onTab("thinking", tabId, (text) => {
            setThinkingText((prev) => prev + text);
        });

        const removeToolUse = onTab("toolUse", tabId, ({id, name, input, parentToolUseId}) => {
            const activity: ToolActivity = {id, name, input, status: "running", parentToolUseId, startedAt: Date.now()};
            toolsRef.current = [...toolsRef.current, activity];
            setTools(toolsRef.current);
            // 서브에이전트가 쓴 도구는 진행 패널에만 보이고 답변 본문에는 넣지 않는다
            // (불러온 대화와 같은 모습)
            if (parentToolUseId) return;
            segs.push({kind: "tool", tool: activity});
            flush();
        });

        const removeToolResult = onTab("toolResult", tabId, ({id, isError, content, images, links}) => {
            const patch = {
                status: (isError ? "error" : "done") as ToolActivity["status"],
                resultPreview: content,
                images,
                resultLinks: links,
            };
            toolsRef.current = toolsRef.current.map((t) => (t.id === id ? {...t, ...patch} : t));
            setTools(toolsRef.current);
            for (let i = 0; i < segs.length; i++) {
                const s = segs[i];
                if (s.kind === "tool" && s.tool.id === id) {
                    segs[i] = {kind: "tool", tool: {...s.tool, ...patch}};
                }
            }
            flush();
        });

        // 대화 압축: 진행 표시(start~done) → 답변 자리에 구분선(boundary) → 구분선의 "요약 보기"(summary).
        // 자동 압축은 답변 도중에 일어나고, 끝나면 같은 답변이 이어진다.
        const removeCompact = onTab("compact", tabId, (ev) => {
            if (ev.phase === "start") {
                setCompacting(compactCommand ? "manual" : "auto");
            } else if (ev.phase === "done" || ev.phase === "failed") {
                // 실패는 따로 알리지 않는다: /compact 실패는 CLI가 답변 글로 알려 주고("Error: …"),
                // 자동 압축 실패("too_few_groups" 등)는 CLI도 조용히 넘어간다
                setCompacting(null);
            } else if (ev.phase === "boundary") {
                setCompacting(null);
                segs.push({kind: "compact", trigger: ev.trigger, preTokens: ev.preTokens, postTokens: ev.postTokens});
                flush();
            } else if (ev.phase === "summary" && ev.summary) {
                for (let i = segs.length - 1; i >= 0; i--) {
                    const sg = segs[i];
                    if (sg.kind === "compact") {
                        segs[i] = {...sg, summary: ev.summary};
                        flush();
                        break;
                    }
                }
            }
        });

        let finished = false;
        const finish = (stopped: boolean) => {
            if (finished) return;
            finished = true;
            if (finishRef.current === finish) finishRef.current = null;
            if (flushTimer !== null) flush();
            removeChunk();
            removeUsage();
            removeError();
            removeTurnUuid();
            removeThinking();
            removeToolUse();
            removeToolResult();
            removeCompact();
            removeReplyUuid();
            removeDone();
            if (replyUuid) {
                const uuid = replyUuid;
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? {...m, replyUuid: uuid} : m)));
            }
            if (stopped) {
                // 결과를 못 받은 도구가 계속 "실행 중"으로 남지 않게 정리한다
                const patch = {status: "error" as const, resultPreview: "중지됨"};
                toolsRef.current = toolsRef.current.map((t) => (t.status === "running" ? {...t, ...patch} : t));
                setTools(toolsRef.current);
                for (let i = 0; i < segs.length; i++) {
                    const seg = segs[i];
                    if (seg.kind === "tool" && seg.tool.status === "running") {
                        segs[i] = {kind: "tool", tool: {...seg.tool, ...patch}};
                    }
                }
                flush();
                setPermissionRequest(null);
                setQuestionRequest(null);
            }
            setIsThinking(false);
            setIsLoading(false);
            setCompacting(null);
            const seq = ++turnSeqRef.current;
            const failedNotice = failed as ChatNotice | null;
            setTurnEnd({seq, stopped, failed: !!failedNotice});
            const lastText = [...segs].reverse().find((sg) => sg.kind === "text" && sg.text.trim());
            callbacksRef.current.onTurnEnd?.({
                seq,
                stopped,
                failed: !!failedNotice,
                summary: failedNotice
                    ? plainSummary(failedNotice.message)
                    : lastText?.kind === "text"
                      ? plainSummary(lastText.text)
                      : segs.some((sg) => sg.kind === "compact")
                        ? "대화를 요약했습니다"
                        : "작업을 마쳤습니다",
            });
        };
        finishRef.current = finish;

        const removeDone = onTab("done", tabId, () => finish(false));

        apiCall();
    }, [nextId, tabId]);

    // 백그라운드 작업이 끝나면 CLI가 사용자 입력 없이 후속 턴을 돌린다 — 새 응답으로 받는다
    useEffect(() => onTab("turnStart", tabId, () => startResponse(() => Promise.resolve())), [startResponse, tabId]);

    // 탭을 닫으면 진행 중이던 턴의 구독을 걷는다 (main은 tabs:close로 프로세스를 끝낸다)
    useEffect(() => () => finishRef.current?.(true), []);

    // images는 이미 변환 완료된 payload 배열을 받음
    const send = useCallback(
        (message: string, images: ImagePayload[] = []) => {
            const trimmed = message.trim();
            if ((!trimmed && images.length === 0) || isLoading) return;

            const userId = nextId();
            setMessages((prev) => [
                ...prev,
                {
                    id: userId,
                    role: "user",
                    content: trimmed,
                    images: images.map((img) => img.previewUrl),
                    imagePayloads: images.length > 0 ? images.map(({data, mediaType}) => ({data, mediaType})) : undefined,
                },
            ]);
            callbacksRef.current.onUserMessage?.(trimmed);

            lastSentRef.current = { message: trimmed, images };
            const imageDataList = images.map(({ data, mediaType }) => ({ data, mediaType }));
            startResponse(
                () => window.electronAPI.sendMessage(tabId, trimmed, imageDataList),
                userId,
                COMPACT_COMMAND_RE.test(trimmed)
            );
        },
        [isLoading, startResponse, nextId, tabId]
    );

    // 마지막 어시스턴트 응답을 버리고 직전 사용자 메시지를 다시 보낸다.
    const regenerate = useCallback(() => {
        if (isLoading) return;
        const trimmed = [...messages];
        while (trimmed.length && trimmed[trimmed.length - 1].role === "assistant") trimmed.pop();
        if (!trimmed.length || trimmed[trimmed.length - 1].role !== "user") return;
        const userMsg = trimmed[trimmed.length - 1];
        const last = lastSentRef.current;
        const message = last?.message ?? userMsg.content;
        const images = last?.images ?? [];
        setMessages(trimmed);
        const imageData = images.map(({ data, mediaType }) => ({ data, mediaType }));
        // uuid를 넘기면 main이 그 메시지 직전부터 이어가서 옛 질문·답이 모델 기록에서도 빠진다
        startResponse(
            () => window.electronAPI.sendMessage(tabId, message, imageData, userMsg.uuid),
            userMsg.id,
            COMPACT_COMMAND_RE.test(message)
        );
    }, [isLoading, messages, startResponse, tabId]);

    // 마지막 사용자 메시지를 수정한 뒤 다시 보낸다.
    const editAndResend = useCallback((newText: string) => {
        if (isLoading) return;
        const text = newText.trim();
        if (!text) return;
        const trimmed = [...messages];
        while (trimmed.length && trimmed[trimmed.length - 1].role === "assistant") trimmed.pop();
        if (!trimmed.length || trimmed[trimmed.length - 1].role !== "user") return;
        const userMsg = trimmed[trimmed.length - 1];
        const images = lastSentRef.current?.images ?? [];
        trimmed[trimmed.length - 1] = { ...userMsg, content: text, inputTokens: undefined };
        setMessages(trimmed);
        lastSentRef.current = { message: text, images };
        const imageData = images.map(({ data, mediaType }) => ({ data, mediaType }));
        startResponse(
            () => window.electronAPI.sendMessage(tabId, text, imageData, userMsg.uuid),
            userMsg.id,
            COMPACT_COMMAND_RE.test(text)
        );
    }, [isLoading, messages, startResponse, tabId]);

    // "여기서 다시": 이 사용자 메시지부터 아래를 버리고, 고친 글로 그 자리에서 다시 보낸다.
    // uuid를 넘기면 main(prepareReplace)이 그 메시지 직전 항목부터 이어가서, 버린 대화는 모델 기록에서도 빠진다.
    const rewriteFrom = useCallback(
        (msgId: number, newText: string) => {
            if (isLoading) return;
            const text = newText.trim();
            const idx = messages.findIndex((m) => m.id === msgId);
            const userMsg = messages[idx];
            if (!text || idx < 0 || userMsg.role !== "user" || !userMsg.uuid) return;
            const imageData = resendableImages(userMsg);
            setMessages([...messages.slice(0, idx), {...userMsg, content: text, inputTokens: undefined, copied: false}]);
            lastSentRef.current = {
                message: text,
                images: imageData.map((d, i) => ({...d, previewUrl: userMsg.images?.[i] ?? ""})),
            };
            callbacksRef.current.onUserMessage?.(text);
            startResponse(
                () => window.electronAPI.sendMessage(tabId, text, imageData, userMsg.uuid),
                userMsg.id,
                COMPACT_COMMAND_RE.test(text)
            );
        },
        [isLoading, messages, startResponse, tabId]
    );

    // 허용/거부를 CLI에 되돌려 보낸다. 예전처럼 요청을 통째로 다시 보내는 게 아니라,
    // 멈춰서 기다리던 그 도구 호출이 그대로 이어진다.
    const respondPermission = useCallback(
        (allow: boolean, always = false) => {
            if (!permissionRequest) return;
            void window.electronAPI.respondPermission(permissionRequest.id, allow, always);
            setPermissionRequest(null);
        },
        [permissionRequest]
    );

    // 선택지 답변을 tool_result로 되돌려 보낸다. 빈 배열이면 건너뛴 것.
    const answerQuestions = useCallback(
        (answers: string[][]) => {
            if (!questionRequest) return;
            void window.electronAPI.answerQuestions(questionRequest.id, answers);
            setQuestionRequest(null);
        },
        [questionRequest]
    );

    // 다른 것 기다리지 않고 즉시 멈춘다: UI 턴을 먼저 닫고, main에는 정리만 맡긴다.
    // 진행 중인 턴이 없어도(백그라운드 작업만 도는 중) main에는 보낸다.
    const stopGeneration = useCallback(() => {
        finishRef.current?.(true);
        void window.electronAPI.stopGeneration(tabId);
    }, [tabId]);

    // 화면만 새 대화로 비운다 — main 쪽은 이미 비웠을 때(폴더 변경, 대화 삭제, 다른 대화 열기 전)
    const resetLocal = useCallback(() => {
        setSuggestion(null);
        setMessages([{ ...INITIAL_MESSAGE, id: nextId() }]);
        setPermissionRequest(null);
        setQuestionRequest(null);
        setNotice(null);
        toolsRef.current = [];
        setTools([]);
        lastSentRef.current = null;
    }, [nextId]);

    // CLI 세션 기록에서 복원한 메시지로 화면을 채운다
    const loadSession = useCallback((loaded: LoadedMessage[]) => {
        setSuggestion(null);
        lastSentRef.current = null;
        toolsRef.current = [];
        setTools([]);
        setNotice(null);
        const restored: Message[] = loaded.map((m) => ({...m, id: nextId()}));
        setMessages(restored.length > 0 ? restored : [{ ...INITIAL_MESSAGE, id: nextId() }]);
    }, [nextId]);

    return {
        messages,
        isLoading,
        isThinking,
        compacting,
        suggestion,
        clearSuggestion,
        permissionRequest,
        questionRequest,
        setPermissionRequest,
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
    } as const;
}
