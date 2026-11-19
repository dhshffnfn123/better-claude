import {useCallback, useEffect, useState} from "react";

// "확장" 창(플러그인 · 스킬 · 훅 · 대화 시작 비용)을 여는 약속. 사이드바 "확장", 입력창의 /plugin, 답변 속 스킬 줄,
// 창 안의 링크(비용 탭의 플러그인 줄 → 플러그인 탭)가 부른다. 셸(chat.page.tsx)이 듣고 창을 연다 — 이미 열려 있으면 그 탭으로
// 옮기고, focus가 있으면 그 항목을 찾아 보여 준다. 모든 탭이 함께 쓰는 값이라 jump-setting.ts처럼 모듈 하나에 둔다.
export type ExtensionsTab = "plugins" | "skills" | "hooks" | "cost";

// focus — 그 탭에서 찾아 보여 줄 것 (없으면 탭 첫 화면):
//   plugins: 플러그인 id("이름@마켓플레이스") 또는 이름 — 설치돼 있으면 설치됨 목록의 그 줄, 없으면 찾아보기에서 그 글로 찾는다
//   skills:  Claude가 부르는 스킬 이름 — 플러그인 스킬은 "플러그인:스킬"(figma:figma-use), 내·프로젝트 스킬은 이름만
//   hooks:   플러그인 id — 그 플러그인이 건 훅
//   cost:    쓰지 않는다
export interface ExtensionsRequest {
    tab: ExtensionsTab;
    focus?: string;
    seq: number; // 부를 때마다 오른다 — 같은 탭·같은 focus로 다시 불러도 다시 찾아간다
}

// 탭 본문(PluginsTab·SkillsTab·HooksTab·CostTab)이 받는 것 — 보고 있는 대화 탭과 그 작업 폴더.
// 폴더마다 다른 것(프로젝트 스킬·훅, 이 레포 범위 플러그인, 대화 시작 비용)은 이 폴더 기준으로 보여 준다.
export interface ExtensionsTabProps {
    tabId: string;
    cwd: string;
    focus?: string;
}

let seq = 0;
let last: ExtensionsTab = "plugins";
const listeners = new Set<(req: ExtensionsRequest) => void>();

export function openExtensions(tab: ExtensionsTab, focus?: string): void {
    const req: ExtensionsRequest = {tab, focus: focus || undefined, seq: ++seq};
    listeners.forEach((l) => l(req));
}

// 마지막으로 본 탭 — 사이드바 "확장"은 거기서 다시 연다 (창이 탭을 옮길 때 적는다)
export function lastExtensionsTab(): ExtensionsTab {
    return last;
}

export function rememberExtensionsTab(tab: ExtensionsTab): void {
    last = tab;
}

// 셸이 쓴다: 마지막 요청(창이 닫혀 있으면 null)과 닫기
export function useExtensionsRequest(): [ExtensionsRequest | null, () => void] {
    const [req, setReq] = useState<ExtensionsRequest | null>(null);
    useEffect(() => {
        listeners.add(setReq);
        return () => {
            listeners.delete(setReq);
        };
    }, []);
    const close = useCallback(() => setReq(null), []);
    return [req, close];
}
