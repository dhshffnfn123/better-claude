import { useCallback, useEffect, useRef, useState } from "react";
import {notifyNeedsInput, notifyTurnDone} from "./useNotificationSound";

export interface ImagePayload {
    previewUrl: string;
    data: string;      // base64
    mediaType: string;
}

export async function readFileAsImagePayload(file: File): Promise<ImagePayload> {
    const previewUrl = URL.createObjectURL(file);
    const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
    return { previewUrl, data, mediaType: file.type || "image/png" };
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
}

export interface ToolActivity {
    id: string;
    name: string;
    input: unknown;
    status: "running" | "done" | "error";
    resultPreview?: string;
    // 서브에이전트(Agent 도구)가 쓴 도구면 그 Agent 호출의 id
    parentToolUseId?: string;
}

export type MessageSegment =
    | {kind: "text"; text: string}
    | {kind: "tool"; tool: ToolActivity};

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

export interface ChatNotice {
    level: "error" | "warning";
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
}

// 알림에 넣을 짧은 글: 코드 블록·마크다운 기호를 빼고 앞부분만
function plainSummary(text: string, max = 140): string {
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

const INITIAL_MESSAGE: Message = {
    id: 1,
    role: "assistant",
    content: "안녕하세요! 무엇을 도와드릴까요?",
    greeting: true,
};

export function useClaudeChat() {
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
    const [turnEnd, setTurnEnd] = useState<TurnEnd>({seq: 0, stopped: false});
    const idCounter = useRef(2);
    const startedAtRef = useRef<number | null>(null);
    const toolsRef = useRef<ToolActivity[]>([]);
    const lastSentRef = useRef<{message: string; images: ImagePayload[]} | null>(null);
    // 진행 중인 턴을 즉시 닫는 함수. 중지 버튼이 main 응답을 기다리지 않고 바로 호출한다.
    const finishRef = useRef<((stopped: boolean) => void) | null>(null);

    useEffect(() => {
        // 앱을 보고 있지 않으면 소리와 macOS 알림으로 알린다 — 답할 때까지 Claude가 멈춰 있다
        const offRequest = window.electronAPI.onPermissionRequest((req) => {
            setPermissionRequest(req);
            notifyNeedsInput("Claude가 허용을 기다립니다", permissionSummary(req));
        });
        const offQuestion = window.electronAPI.onQuestionRequest((req) => {
            setQuestionRequest(req);
            const first = req.questions[0]?.question ?? "";
            const more = req.questions.length > 1 ? ` 외 ${req.questions.length - 1}개` : "";
            notifyNeedsInput("Claude의 질문", plainSummary(first) + more);
        });
        // 턴이 끝나면 답할 수 없는 요청이 되므로 모달을 닫는다 (id가 null이면 전부)
        const offResolved = window.electronAPI.onPermissionResolved(({id}) => {
            setPermissionRequest((cur) => (cur && (id === null || cur.id === id) ? null : cur));
            setQuestionRequest((cur) => (cur && (id === null || cur.id === id) ? null : cur));
        });
        return () => {
            offRequest();
            offQuestion();
            offResolved();
        };
    }, []);

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

    const startResponse = useCallback((apiCall: () => Promise<void>, userId?: number) => {
        const assistantId = nextId();

        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setThinkingText("");
        setTools([]);
        toolsRef.current = [];
        setRunningTokens({input: 0, output: 0});
        setNotice(null);

        setIsLoading(true);
        setIsThinking(true);
        setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", segments: [] }]);

        // 텍스트/도구를 발생 순서대로 보관 → 도구 호출 전후 멘트가 한 말풍선에 뒤섞이지 않게 분리.
        const segs: MessageSegment[] = [];
        const flush = () => {
            const content = segs
                .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
                .map((s) => s.text)
                .join("\n\n");
            const snapshot = segs.map((s) =>
                s.kind === "text"
                    ? { kind: "text" as const, text: s.text }
                    : { kind: "tool" as const, tool: s.tool }
            );
            setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content, segments: snapshot } : m))
            );
        };

        const removeChunk = window.electronAPI.onChunk((text) => {
            setIsThinking(false);
            const last = segs[segs.length - 1];
            if (last && last.kind === "text") last.text += text;
            else segs.push({ kind: "text", text });
            flush();
        });

        const removeUsage = window.electronAPI.onUsage((usage) => {
            setRunningTokens({input: usage.inputTokens, output: usage.outputTokens});
            setMessages((prev) =>
                prev.map((m) => {
                    if (m.id === assistantId) return { ...m, outputTokens: usage.outputTokens };
                    if (userId !== undefined && m.id === userId) return { ...m, inputTokens: usage.inputTokens };
                    return m;
                })
            );
        });

        // 오류로 끝난 턴은 알림 문구를 바꾼다
        let failed: ChatNotice | null = null;
        const removeError = window.electronAPI.onChatError((n) => {
            setNotice(n);
            if (n.level === "error") failed = n;
        });

        const removeTurnUuid = window.electronAPI.onTurnUuid(({uuid}) => {
            if (userId === undefined) return;
            setMessages((prev) => prev.map((m) => (m.id === userId ? {...m, uuid} : m)));
        });

        const removeThinking = window.electronAPI.onThinking((text) => {
            setThinkingText((prev) => prev + text);
        });

        const removeToolUse = window.electronAPI.onToolUse(({id, name, input, parentToolUseId}) => {
            const activity: ToolActivity = {id, name, input, status: "running", parentToolUseId};
            toolsRef.current = [...toolsRef.current, activity];
            setTools(toolsRef.current);
            // 서브에이전트가 쓴 도구는 진행 패널에만 보이고 답변 본문에는 넣지 않는다
            // (불러온 대화와 같은 모습)
            if (parentToolUseId) return;
            segs.push({kind: "tool", tool: activity});
            flush();
        });

        const removeToolResult = window.electronAPI.onToolResult(({id, isError, content}) => {
            const patch = {
                status: (isError ? "error" : "done") as ToolActivity["status"],
                resultPreview: content,
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

        let finished = false;
        const finish = (stopped: boolean) => {
            if (finished) return;
            finished = true;
            if (finishRef.current === finish) finishRef.current = null;
            removeChunk();
            removeUsage();
            removeError();
            removeTurnUuid();
            removeThinking();
            removeToolUse();
            removeToolResult();
            removeDone();
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
            setTurnEnd((t) => ({seq: t.seq + 1, stopped}));
            // 사용자가 직접 중지한 건 완료가 아니므로 알리지 않는다
            if (!stopped) {
                const lastText = [...segs].reverse().find((sg) => sg.kind === "text" && sg.text.trim());
                if (failed) notifyTurnDone("응답이 오류로 끝났습니다", plainSummary(failed.message));
                else notifyTurnDone("응답 완료", lastText?.kind === "text" ? plainSummary(lastText.text) : "작업을 마쳤습니다");
            }
        };
        finishRef.current = finish;

        const removeDone = window.electronAPI.onDone(() => finish(false));

        apiCall();
    }, [nextId]);

    // 백그라운드 작업이 끝나면 CLI가 사용자 입력 없이 후속 턴을 돌린다 — 새 응답으로 받는다
    useEffect(() => window.electronAPI.onTurnStart(() => startResponse(() => Promise.resolve())), [startResponse]);

    // images는 이미 변환 완료된 payload 배열을 받음
    const send = useCallback(
        (message: string, images: ImagePayload[] = []) => {
            const trimmed = message.trim();
            if ((!trimmed && images.length === 0) || isLoading) return;

            const userId = nextId();
            setMessages((prev) => [
                ...prev,
                { id: userId, role: "user", content: trimmed, images: images.map((img) => img.previewUrl) },
            ]);

            lastSentRef.current = { message: trimmed, images };
            const imageDataList = images.map(({ data, mediaType }) => ({ data, mediaType }));
            startResponse(() => window.electronAPI.sendMessage(trimmed, imageDataList), userId);
        },
        [isLoading, startResponse, nextId]
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
        startResponse(() => window.electronAPI.sendMessage(message, imageData, userMsg.uuid), userMsg.id);
    }, [isLoading, messages, startResponse]);

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
        startResponse(() => window.electronAPI.sendMessage(text, imageData, userMsg.uuid), userMsg.id);
    }, [isLoading, messages, startResponse]);

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
        void window.electronAPI.stopGeneration();
    }, []);

    const newConversation = useCallback(async () => {
        await window.electronAPI.newConversation();
        setMessages([{ ...INITIAL_MESSAGE, id: nextId() }]);
        setPermissionRequest(null);
        lastSentRef.current = null;
    }, [nextId]);

    // CLI 세션 기록에서 복원한 메시지로 화면을 채운다
    const loadSession = useCallback((loaded: LoadedMessage[]) => {
        lastSentRef.current = null;
        toolsRef.current = [];
        setTools([]);
        const restored: Message[] = loaded.map((m) => ({...m, id: nextId()}));
        setMessages(restored.length > 0 ? restored : [{ ...INITIAL_MESSAGE, id: nextId() }]);
    }, [nextId]);

    return {
        messages,
        isLoading,
        isThinking,
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
        respondPermission,
        answerQuestions,
        stopGeneration,
        newConversation,
        loadSession,
    } as const;
}
