import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
    sendMessage: (message: string, images?: { data: string; mediaType: string }[]) =>
        ipcRenderer.invoke("chat:send", message, images ?? []),
    // 드래그/선택한 파일의 디스크 절대경로를 얻는다 (Electron 41은 File.path 제거됨).
    // 빈 문자열이면 디스크에 실재하지 않는 파일(예: 메모리상 붙여넣기).
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    newConversation: () => ipcRenderer.invoke("chat:new"),
    // always: CLI가 제안한 규칙을 이 대화 동안 항상 허용
    respondPermission: (id: string, allow: boolean, always?: boolean) =>
        ipcRenderer.invoke("chat:permission_response", id, allow, always ?? false),
    rewindFiles: (uuid: string, dryRun: boolean) => ipcRenderer.invoke("chat:rewind_files", uuid, dryRun),
    getRateLimits: () => ipcRenderer.invoke("chat:get_rate_limits"),
    answerQuestions: (id: string, answers: string[][]) =>
        ipcRenderer.invoke("chat:question_response", id, answers),
    setPermissions: (allow: boolean) => ipcRenderer.invoke("chat:set_permissions", allow),
    stopGeneration: () => ipcRenderer.invoke("chat:stop"),
    onChunk: (callback: (text: string) => void) => {
        const handler = (_: unknown, text: string) => callback(text);
        ipcRenderer.on("chat:chunk", handler);
        return () => ipcRenderer.removeListener("chat:chunk", handler);
    },
    onDone: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.once("chat:done", handler);
        return () => ipcRenderer.removeListener("chat:done", handler);
    },
    onChatError: (callback: (data: { level: "error" | "warning"; message: string; detail?: string }) => void) => {
        const handler = (_: unknown, data: { level: "error" | "warning"; message: string; detail?: string }) =>
            callback(data);
        ipcRenderer.on("chat:error", handler);
        return () => ipcRenderer.removeListener("chat:error", handler);
    },
    onPermissionRequest: (callback: (data: PermissionRequestData) => void) => {
        const handler = (_: unknown, data: PermissionRequestData) => callback(data);
        ipcRenderer.on("chat:permission_request", handler);
        return () => ipcRenderer.removeListener("chat:permission_request", handler);
    },
    // AskUserQuestion — 권한이 아니라 선택지 질문
    onQuestionRequest: (callback: (data: { id: string; questions: AskQuestion[] }) => void) => {
        const handler = (_: unknown, data: { id: string; questions: AskQuestion[] }) => callback(data);
        ipcRenderer.on("chat:question_request", handler);
        return () => ipcRenderer.removeListener("chat:question_request", handler);
    },
    // 턴이 끝나거나 취소돼서 더 이상 답할 수 없게 된 요청을 닫는다. id가 null이면 전부.
    onPermissionResolved: (callback: (data: { id: string | null }) => void) => {
        const handler = (_: unknown, data: { id: string | null }) => callback(data);
        ipcRenderer.on("chat:permission_resolved", handler);
        return () => ipcRenderer.removeListener("chat:permission_resolved", handler);
    },
    onUsage: (callback: (data: { inputTokens: number; outputTokens: number }) => void) => {
        const handler = (_: unknown, data: { inputTokens: number; outputTokens: number }) => callback(data);
        ipcRenderer.on("chat:usage", handler);
        return () => ipcRenderer.removeListener("chat:usage", handler);
    },
    onThinking: (callback: (text: string) => void) => {
        const handler = (_: unknown, text: string) => callback(text);
        ipcRenderer.on("chat:thinking", handler);
        return () => ipcRenderer.removeListener("chat:thinking", handler);
    },
    onToolUse: (callback: (data: { id: string; name: string; input: unknown }) => void) => {
        const handler = (_: unknown, data: { id: string; name: string; input: unknown }) => callback(data);
        ipcRenderer.on("chat:tool_use", handler);
        return () => ipcRenderer.removeListener("chat:tool_use", handler);
    },
    onToolResult: (callback: (data: { id: string; isError: boolean; content: string }) => void) => {
        const handler = (_: unknown, data: { id: string; isError: boolean; content: string }) => callback(data);
        ipcRenderer.on("chat:tool_result", handler);
        return () => ipcRenderer.removeListener("chat:tool_result", handler);
    },
    // 방금 보낸 사용자 메시지의 uuid (파일 되돌리기 기준점)
    onTurnUuid: (callback: (data: { uuid: string }) => void) => {
        const handler = (_: unknown, data: { uuid: string }) => callback(data);
        ipcRenderer.on("chat:turn_uuid", handler);
        return () => ipcRenderer.removeListener("chat:turn_uuid", handler);
    },
    // 요금제 사용량 한도 (claude.ai 구독)
    onRateLimits: (callback: (limits: RateLimitWindow[]) => void) => {
        const handler = (_: unknown, limits: RateLimitWindow[]) => callback(limits);
        ipcRenderer.on("chat:rate_limits", handler);
        return () => ipcRenderer.removeListener("chat:rate_limits", handler);
    },
    // 백그라운드 작업이 끝나 CLI가 스스로 시작한 턴
    onTurnStart: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.on("chat:turn_start", handler);
        return () => ipcRenderer.removeListener("chat:turn_start", handler);
    },
    // 실행 중인 백그라운드 작업 목록 (바뀔 때마다 전체 목록)
    onBackgroundTasks: (callback: (tasks: BackgroundTask[]) => void) => {
        const handler = (_: unknown, tasks: BackgroundTask[]) => callback(tasks);
        ipcRenderer.on("chat:background", handler);
        return () => ipcRenderer.removeListener("chat:background", handler);
    },
    // 세션 누적 예상 비용 (턴이 끝날 때마다)
    onCost: (callback: (data: { totalCostUsd: number }) => void) => {
        const handler = (_: unknown, data: { totalCostUsd: number }) => callback(data);
        ipcRenderer.on("chat:cost", handler);
        return () => ipcRenderer.removeListener("chat:cost", handler);
    },
    // 컨텍스트 창 사용량 (턴이 끝날 때마다)
    onContextUsage: (callback: (data: ContextUsage) => void) => {
        const handler = (_: unknown, data: ContextUsage) => callback(data);
        ipcRenderer.on("chat:context", handler);
        return () => ipcRenderer.removeListener("chat:context", handler);
    },
    getCwd: () => ipcRenderer.invoke("chat:get_cwd"),
    searchFiles: (query: string) => ipcRenderer.invoke("files:search", query),
    selectDirectory: () => ipcRenderer.invoke("dialog:select_directory"),
    getModel: () => ipcRenderer.invoke("chat:get_model"),
    setModel: (model: string) => ipcRenderer.invoke("chat:set_model", model),
    getEffort: () => ipcRenderer.invoke("chat:get_effort"),
    setEffort: (effort: string) => ipcRenderer.invoke("chat:set_effort", effort),
    getUltracode: () => ipcRenderer.invoke("chat:get_ultracode"),
    setUltracode: (on: boolean) => ipcRenderer.invoke("chat:set_ultracode", on),
    getFastMode: () => ipcRenderer.invoke("chat:get_fast_mode"),
    setFastMode: (on: boolean) => ipcRenderer.invoke("chat:set_fast_mode", on),
    listModels: () => ipcRenderer.invoke("models:list"),
    getPrompts: () => ipcRenderer.invoke("prompts:get"),
    addPrompt: (prompt: string) => ipcRenderer.invoke("prompts:add", prompt),
    removePrompt: (index: number) => ipcRenderer.invoke("prompts:remove", index),
    listCommands: () => ipcRenderer.invoke("commands:list"),
    getSessionId: () => ipcRenderer.invoke("chat:get_session_id"),
    // 세션 이어가기 — 세션의 작업 폴더로 옮긴 뒤 실제 작업 폴더를 돌려준다
    resumeSession: (sessionId: string, cwd?: string) => ipcRenderer.invoke("chat:resume_session", sessionId, cwd),
    // CLI 세션 기록 (터미널에서 한 대화 포함)
    listSessions: () => ipcRenderer.invoke("sessions:list"),
    loadSessionMessages: (sessionId: string, cwd?: string) => ipcRenderer.invoke("sessions:messages", sessionId, cwd),
    deleteSession: (sessionId: string, cwd?: string) => ipcRenderer.invoke("sessions:delete", sessionId, cwd),
    getMcpStatus: (refresh?: boolean) => ipcRenderer.invoke("mcp:status", refresh ?? false),
    // 작업 폴더가 바뀌거나 CLI가 새 스킬을 발견하면 전체 목록이 다시 온다
    onCommands: (callback: (commands: SlashCommand[]) => void) => {
        const handler = (_: unknown, commands: SlashCommand[]) => callback(commands);
        ipcRenderer.on("chat:commands", handler);
        return () => ipcRenderer.removeListener("chat:commands", handler);
    },
    onMcpStatus: (callback: (servers: McpServer[]) => void) => {
        const handler = (_: unknown, servers: McpServer[]) => callback(servers);
        ipcRenderer.on("chat:mcp", handler);
        return () => ipcRenderer.removeListener("chat:mcp", handler);
    },
    getClaudeStatus: () => ipcRenderer.invoke("claude:get_status"),
    locateClaude: () => ipcRenderer.invoke("claude:locate"),
    openClaudeInstallGuide: () => ipcRenderer.invoke("claude:open_install_guide"),
    onClaudeNotFound: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.on("claude:not_found", handler);
        return () => ipcRenderer.removeListener("claude:not_found", handler);
    },
});
