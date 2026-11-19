// MCP 도구 줄 — 일반 층. "mcp__plugin_figma_figma__get_design_context"가 그대로 찍히던 자리에 "서버 · 도구" + 입력 요약.
// 특정 서버는 꾸미기(decorator)를 등록해 이름·요약·아이콘·열기 링크를 바꾼다 — 이 파일은 어느 서버도 모른다
// (Figma는 figma-tool-display.ts가 등록한다). ToolRow(답변·진행 패널·에이전트 패널), 답변 속 그림 이름,
// 백그라운드 패널의 "최근에 쓴 도구"가 같이 쓴다. 컴포넌트 파일과 따로 둔다(Fast Refresh).
import {type ComponentType, useEffect, useState} from "react";
import {mcpInputSummary, mcpServerLabel, parseMcpToolName} from "../shared/mcp-tools";

export interface McpToolLink {
    url: string; // 웹 주소 — 새 창 요청으로 열면 main(link-guard)이 기본 브라우저로 연다
    label: string;
}

export interface McpToolDisplay {
    server: string; // 화면용 서버 이름 (plugin_figma_figma → figma)
    tool: string; // 원래 도구 이름
    title: string; // 줄의 이름 — 기본 "서버 · 도구"
    detail: string; // 줄 뒤에 흐리게 — 기본은 입력 요약
    Icon?: ComponentType<{className?: string}>;
    links: McpToolLink[]; // 줄 오른쪽 끝의 열기 링크
    imageName?: string; // 도구 결과에 든 그림의 이름 (기본 "<이름> 결과")
}

// 꾸미기가 받는 것: 서버(바뀐 이름 그대로)·도구, 입력, 결과(main이 결과 전체에서 찾은 주소, 결과 앞부분)
export interface McpToolCall {
    server: string;
    tool: string;
    input: Record<string, unknown>;
    resultLinks?: string[];
    resultPreview?: string;
}

// 바꿀 것만 돌려준다. 자기 서버가 아니면 null.
export type McpToolDecorator = (call: McpToolCall) => Partial<Omit<McpToolDisplay, "server" | "tool">> | null;

// 이름으로 등록 — 같은 이름을 다시 등록하면 바꿔 끼운다(Fast Refresh로 모듈이 다시 돌아도 겹치지 않게)
const decorators = new Map<string, McpToolDecorator>();

export function registerMcpToolDecorator(id: string, decorate: McpToolDecorator) {
    decorators.set(id, decorate);
    refreshMcpToolDisplays();
}

// 꾸미기 결과가 달라졌다(설정에서 끄고 켬 등) — 판을 올려 도구 줄들이 다시 그리게 한다
let version = 0;
const versionListeners = new Set<(v: number) => void>();

export function refreshMcpToolDisplays() {
    version += 1;
    versionListeners.forEach((l) => l(version));
}

// 도구 줄을 그리는 곳이 메모 의존성에 넣는다
export function useMcpDisplayVersion(): number {
    const [v, setV] = useState(version);
    useEffect(() => {
        versionListeners.add(setV);
        setV(version);
        return () => {
            versionListeners.delete(setV);
        };
    }, []);
    return v;
}

export function mcpToolDisplay(name: string, input: unknown, resultLinks?: string[], resultPreview?: string): McpToolDisplay | null {
    const m = parseMcpToolName(name);
    if (!m) return null;
    const server = mcpServerLabel(m.server);
    const base: McpToolDisplay = {server, tool: m.tool, title: `${server} · ${m.tool}`, detail: mcpInputSummary(input), links: []};
    const call: McpToolCall = {
        server: m.server,
        tool: m.tool,
        input: (input && typeof input === "object" ? input : {}) as Record<string, unknown>,
        resultLinks,
        resultPreview,
    };
    for (const decorate of decorators.values()) {
        const patch = decorate(call);
        if (patch) return {...base, ...patch};
    }
    return base;
}

// 한 줄짜리 이름 (백그라운드 패널의 "에이전트가 최근에 쓴 도구" 등). MCP가 아니면 그대로.
export function toolShortName(name: string): string {
    return mcpToolDisplay(name, undefined)?.title ?? name;
}

// 도구 결과에 든 그림의 이름 (답변 속 그림 줄)
export function toolImageName(name: string, input: unknown): string {
    const d = mcpToolDisplay(name, input);
    return d?.imageName ?? `${d?.title ?? name} 결과`;
}
