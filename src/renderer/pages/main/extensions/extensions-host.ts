import {createContext, useContext} from "react";

// 확장 창 안에서 창 바깥의 것을 여는 길 — 창(ExtensionsDialog)이 셸의 동작을 받아 내려 준다.
// 탭 본문은 필요할 때만 쓴다(useExtensionsHost). 컴포넌트 파일에서 컴포넌트가 아닌 것을 내보내면 Fast Refresh가 꺼져서 따로 둔다.
export interface ExtensionsHost {
    close: () => void; // 확장 창을 닫는다
    openMcp: () => void; // 창을 닫고 작업 폴더 줄의 MCP 목록을 연다 (로그인이 필요한 서버의 [로그인])
    openInstructions: () => void; // 창을 닫고 오른쪽 지침 패널을 연다 (CLAUDE.md …)
}

const NOOP: ExtensionsHost = {close: () => undefined, openMcp: () => undefined, openInstructions: () => undefined};

export const ExtensionsHostContext = createContext<ExtensionsHost>(NOOP);

export function useExtensionsHost(): ExtensionsHost {
    return useContext(ExtensionsHostContext);
}
