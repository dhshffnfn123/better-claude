import { contextBridge, ipcRenderer, webUtils } from "electron";

// 탭마다 오는 이벤트 — main이 첫 인자로 탭 id를 붙여 보낸다(main.ts의 send).
// 렌더러는 tab-events.ts에서 이벤트마다 한 번만 구독해 탭별로 나눠 준다.
const TAB_EVENTS = {
    chunk: "chat:chunk",
    thinking: "chat:thinking",
    done: "chat:done",
    error: "chat:error",
    usage: "chat:usage",
    toolUse: "chat:tool_use",
    toolResult: "chat:tool_result",
    turnUuid: "chat:turn_uuid",
    turnStart: "chat:turn_start",
    permissionRequest: "chat:permission_request",
    questionRequest: "chat:question_request",
    permissionResolved: "chat:permission_resolved",
    background: "chat:background",
    cost: "chat:cost",
    context: "chat:context",
    commands: "chat:commands",
    mcp: "chat:mcp",
    changedFiles: "files:changed",
    session: "chat:session",
    compact: "chat:compact",
} as const;

contextBridge.exposeInMainWorld("electronAPI", {
    // ── 탭 ──
    // 새 탭·저장된 대화를 탭에 열기. 세션의 작업 폴더가 없으면 cwdMissing.
    openTab: (tabId: string, init?: object) => ipcRenderer.invoke("tabs:open", tabId, init ?? {}),
    closeTab: (tabId: string) => ipcRenderer.invoke("tabs:close", tabId),
    // 앱을 다시 켰을 때 열 탭 목록
    loadTabs: () => ipcRenderer.invoke("tabs:load"),
    saveTabs: (state: object) => ipcRenderer.invoke("tabs:save", state),
    onTabEvent: (event: keyof typeof TAB_EVENTS, callback: (tabId: string, payload: unknown) => void) => {
        const channel = TAB_EVENTS[event];
        const handler = (_: unknown, tabId: string, payload: unknown) => callback(tabId, payload);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    },
    // 앱 메뉴의 탭 단축키 (⌘T, ⌘W, ⌃Tab, ⌘1~9)
    onMenuTab: (callback: (action: string) => void) => {
        const handler = (_: unknown, action: string) => callback(action);
        ipcRenderer.on("menu:tab", handler);
        return () => ipcRenderer.removeListener("menu:tab", handler);
    },

    // ── 대화 (탭별) ──
    // replaceUuid: 재생성·편집일 때 대신할 사용자 메시지의 uuid
    sendMessage: (tabId: string, message: string, images?: { data: string; mediaType: string }[], replaceUuid?: string) =>
        ipcRenderer.invoke("chat:send", tabId, message, images ?? [], replaceUuid),
    stopGeneration: (tabId: string) => ipcRenderer.invoke("chat:stop", tabId),
    rewindFiles: (tabId: string, uuid: string, dryRun: boolean) => ipcRenderer.invoke("chat:rewind_files", tabId, uuid, dryRun),
    setPermissions: (tabId: string, allow: boolean) => ipcRenderer.invoke("chat:set_permissions", tabId, allow),
    // 권한·질문 답은 요청 id로 찾아간다 (id는 탭끼리 겹치지 않는다)
    // always: CLI가 제안한 규칙을 이 대화 동안 항상 허용
    respondPermission: (id: string, allow: boolean, always?: boolean) =>
        ipcRenderer.invoke("chat:permission_response", id, allow, always ?? false),
    answerQuestions: (id: string, answers: string[][]) => ipcRenderer.invoke("chat:question_response", id, answers),

    // ── 채팅 설정 (탭별, 바꾼 값은 다음 새 탭의 기본값) ──
    setModel: (tabId: string, model: string) => ipcRenderer.invoke("chat:set_model", tabId, model),
    setEffort: (tabId: string, effort: string) => ipcRenderer.invoke("chat:set_effort", tabId, effort),
    setUltracode: (tabId: string, on: boolean) => ipcRenderer.invoke("chat:set_ultracode", tabId, on),
    setFastMode: (tabId: string, on: boolean) => ipcRenderer.invoke("chat:set_fast_mode", tabId, on),
    listModels: () => ipcRenderer.invoke("models:list"),

    // ── 작업 폴더·파일 패널 (탭별) ──
    selectDirectory: (tabId: string) => ipcRenderer.invoke("dialog:select_directory", tabId),
    searchFiles: (tabId: string, query: string) => ipcRenderer.invoke("files:search", tabId, query),
    getFileChanges: (tabId: string, path: string) => ipcRenderer.invoke("files:changes", tabId, path),
    clearChangedFiles: (tabId: string) => ipcRenderer.invoke("files:clear_changed", tabId),
    resolveEditorTarget: (tabId: string, raw: string) => ipcRenderer.invoke("editor:resolve", tabId, raw),
    openInEditor: (tabId: string, raw: string) => ipcRenderer.invoke("editor:open", tabId, raw),
    listDir: (tabId: string, dir: string) => ipcRenderer.invoke("files:list_dir", tabId, dir),
    readFileForView: (tabId: string, path: string) => ipcRenderer.invoke("files:read", tabId, path),
    revealFile: (tabId: string, path: string) => ipcRenderer.invoke("files:reveal", tabId, path),
    // "Git 변경" 보기: 마지막 커밋 이후 바뀐 파일, 파일 하나의 차이
    gitStatus: (tabId: string) => ipcRenderer.invoke("git:status", tabId),
    gitDiff: (tabId: string, path: string) => ipcRenderer.invoke("git:diff", tabId, path),
    listCommands: (tabId: string) => ipcRenderer.invoke("commands:list", tabId),
    getMcpStatus: (tabId: string, refresh?: boolean) => ipcRenderer.invoke("mcp:status", tabId, refresh ?? false),

    // ── 백그라운드 작업 패널 (탭별): 셸 작업의 최근 출력, 작업 하나만 중지 ──
    getBackgroundOutput: (tabId: string, taskId: string) => ipcRenderer.invoke("background:output", tabId, taskId),
    stopBackgroundTask: (tabId: string, taskId: string) => ipcRenderer.invoke("background:stop", tabId, taskId),
    clearFinishedBackground: (tabId: string) => ipcRenderer.invoke("background:clear_finished", tabId),

    // ── 앱 전체 ──
    // 드래그/선택한 파일의 디스크 절대경로를 얻는다 (Electron 41은 File.path 제거됨).
    // 빈 문자열이면 디스크에 실재하지 않는 파일(예: 메모리상 붙여넣기).
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    getRateLimits: () => ipcRenderer.invoke("chat:get_rate_limits"),
    // 요금제 사용량 한도 (claude.ai 구독) — 계정 전체라 탭 id 없이 온다
    onRateLimits: (callback: (limits: RateLimitWindow[]) => void) => {
        const handler = (_: unknown, limits: RateLimitWindow[]) => callback(limits);
        ipcRenderer.on("chat:rate_limits", handler);
        return () => ipcRenderer.removeListener("chat:rate_limits", handler);
    },
    copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text),
    // macOS 알림 (언제 띄울지는 렌더러가 정한다)
    showNotification: (n: {title: string; body: string; tabId?: string}) => ipcRenderer.invoke("notify:show", n),
    onNotificationClick: (callback: (tabId: string) => void) => {
        const handler = (_e: Electron.IpcRendererEvent, tabId: string) => callback(tabId);
        ipcRenderer.on("notify:clicked", handler);
        return () => ipcRenderer.removeListener("notify:clicked", handler);
    },
    // 화면 테마: system(macOS를 따름) | light | dark
    getTheme: () => ipcRenderer.invoke("theme:get"),
    setTheme: (source: ThemeSource) => ipcRenderer.invoke("theme:set", source),
    getPrompts: () => ipcRenderer.invoke("prompts:get"),
    addPrompt: (prompt: string) => ipcRenderer.invoke("prompts:add", prompt),
    removePrompt: (index: number) => ipcRenderer.invoke("prompts:remove", index),
    // CLI 세션 기록 (터미널에서 한 대화 포함)
    listSessions: () => ipcRenderer.invoke("sessions:list"),
    loadSessionMessages: (sessionId: string, cwd?: string) => ipcRenderer.invoke("sessions:messages", sessionId, cwd),
    deleteSession: (sessionId: string, cwd?: string) => ipcRenderer.invoke("sessions:delete", sessionId, cwd),
    getClaudeStatus: () => ipcRenderer.invoke("claude:get_status"),
    locateClaude: () => ipcRenderer.invoke("claude:locate"),
    openClaudeInstallGuide: () => ipcRenderer.invoke("claude:open_install_guide"),
    onClaudeNotFound: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.on("claude:not_found", handler);
        return () => ipcRenderer.removeListener("claude:not_found", handler);
    },
});
