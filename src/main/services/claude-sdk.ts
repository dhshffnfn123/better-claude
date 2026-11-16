import type {
    deleteSession,
    forkSession,
    getSessionInfo,
    getSessionMessages,
    listSessions,
    McpServerStatus,
    ModelInfo,
    Options,
    PermissionResult,
    PermissionUpdate,
    Query,
    RewindFilesResult,
    SDKControlInitializeResponse,
    SDKMessage,
    SDKUserMessage,
    SessionMessage,
    SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

// SDK는 ESM 전용("type": "module", sdk.mjs만 제공)인데 Electron main 번들은 CJS다.
// 세 가지가 세트로 맞아야 동작한다:
//   1) 정적 import는 CJS에서 require()로 바뀌어 ESM 패키지를 못 읽는다 → 동적 import 사용
//   2) 평범한 동적 import()마저 Rollup이 CJS 출력에서 require()로 낮춘다
//      → new Function으로 감싸 번들러 눈에 띄지 않게 한다
//   3) 그러려면 패키지가 디스크에 실물로 있어야 한다
//      → vite.main.config.ts의 external + forge.config.ts의 복사 목록
// SDK를 Vite로 인라인하는 건 시도해봤고 rollup이 파싱 단계에서 실패한다.
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;

interface SdkModule {
    query: (params: {
        prompt: string | AsyncIterable<SDKUserMessage>;
        options?: Options;
    }) => Query;
    // CLI 세션 기록(~/.claude/projects) — 터미널에서 한 대화도 포함된다
    listSessions: typeof listSessions;
    getSessionMessages: typeof getSessionMessages;
    // 없는 세션이면 undefined (getSessionMessages는 빈 배열이라 구분이 안 된다)
    getSessionInfo: typeof getSessionInfo;
    deleteSession: typeof deleteSession;
    // 이 지점까지를 새 세션으로 복사 ("여기까지 새 탭으로") — 파일 되돌리기 기록은 복사하지 않는다
    forkSession: typeof forkSession;
}

let cached: SdkModule | null = null;

export async function loadSdk(): Promise<SdkModule> {
    if (!cached) {
        cached = (await esmImport("@anthropic-ai/claude-agent-sdk")) as SdkModule;
    }
    return cached;
}

export type {McpServerStatus, ModelInfo, Options, PermissionResult, PermissionUpdate, Query, RewindFilesResult, SDKControlInitializeResponse, SDKMessage, SDKUserMessage, SessionMessage, SlashCommand};
