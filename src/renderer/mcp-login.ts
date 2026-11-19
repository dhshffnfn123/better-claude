import {useEffect, useState} from "react";

// MCP 서버 로그인 진행 상태 (서버 이름별). 토큰은 탭·작업 폴더와 무관하게 저장돼서 탭이 아니라 앱 전체 상태다 —
// main이 모든 창에 보낸다(mcp:login). MCP 팝업을 닫았다 열어도, 탭을 바꿔도 남는다. 화면을 새로 띄우면 진행 중인 것만 다시 받는다.
type Logins = Record<string, McpLoginState>;

let current: Logins = {};
const listeners = new Set<(logins: Logins) => void>();

// "로그인했습니다" 표시는 잠깐만 — 그 뒤에는 목록의 상태(연결됨)가 말해 준다. 남겨 두면 나중에 토큰이 만료돼
// "인증 필요"로 돌아갔을 때 "연결을 확인하는 중"으로 잘못 보인다.
const DONE_KEEP_MS = 20_000;

function publish(next: Logins) {
    current = next;
    listeners.forEach((l) => l(current));
}

function apply(state: McpLoginState) {
    if (!state.name) return;
    const prev = current[state.name];
    if (prev && prev.seq > state.seq) return; // 늦게 온 옛 상태
    if (state.phase === "cancelled") {
        forgetMcpLogin(state.name);
        return;
    }
    publish({...current, [state.name]: state});
    if (state.phase === "done") {
        setTimeout(() => {
            if (current[state.name] === state) forgetMcpLogin(state.name);
        }, DONE_KEEP_MS);
    }
}

window.electronAPI.onMcpLogin(apply);
void window.electronAPI.getMcpLoginStates().then((list) => list.forEach(apply));

export function useMcpLogins(): Logins {
    const [logins, setLogins] = useState(current);
    useEffect(() => {
        listeners.add(setLogins);
        setLogins(current);
        return () => {
            listeners.delete(setLogins);
        };
    }, []);
    return logins;
}

// [로그인] — 누르자마자 "준비 중"으로 보이고, main의 답(로그인 주소를 연 뒤의 상태)으로 바뀐다
export async function loginMcp(tabId: string, name: string): Promise<void> {
    apply({name, phase: "starting", seq: current[name]?.seq ?? 0});
    try {
        apply(await window.electronAPI.mcpLogin(tabId, name));
    } catch (e) {
        apply({name, phase: "error", seq: current[name]?.seq ?? 0, error: (e as Error).message});
    }
}

export function cancelMcpLogin(name: string): void {
    void window.electronAPI.cancelMcpLogin(name);
}

// 끝난 상태(오류, claude.ai 안내, 로그인함)를 지운다
export function forgetMcpLogin(name: string): void {
    if (!current[name]) return;
    const next = {...current};
    delete next[name];
    publish(next);
}
