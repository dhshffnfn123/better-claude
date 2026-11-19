// Figma 링크 카드와 빠른 작업 — 입력창에 붙인 Figma 링크를 카드로 보이고(파일 이름·종류·프레임은 주소에서 알아낸다,
// Figma에 묻지 않는다), 자주 하는 일을 누르면 준비된 요청문으로 입력창을 채운다(보내는 건 사용자).
// 보낸 메시지도 같은 카드로 그린다 — 따로 저장하지 않고 메시지 글에서 다시 찾으므로 다시 연 대화도 같다.
// 컴포넌트 파일과 따로 둔다(Fast Refresh).
import {type FigmaLink, figmaLinksIn} from "../shared/figma";

export interface FigmaQuickAction {
    id: string;
    label: string;
    prompt: string[]; // 요청문 줄 — 마지막에 링크가 붙는다
}

export const FIGMA_ACTIONS: FigmaQuickAction[] = [
    {
        id: "implement",
        label: "이 화면 구현",
        prompt: [
            "이 Figma 화면을 지금 프로젝트에 구현해줘.",
            "- 프로젝트에 이미 있는 컴포넌트·색·간격 값을 먼저 찾아서 쓰고",
            "- 그림·아이콘은 Figma에서 받은 파일을 그대로 써줘",
        ],
    },
    {
        id: "inspect",
        label: "디자인만 보기",
        prompt: [
            "이 Figma 화면을 보고 어떻게 생겼는지 정리해줘. 아직 코드는 고치지 마.",
            "- 화면 구성과 레이아웃, 쓰인 색·글꼴·간격",
            "- 구현할 때 조심할 점",
        ],
    },
    {
        id: "tokens",
        label: "색·간격 토큰 뽑기",
        prompt: [
            "이 Figma 화면에 쓰인 변수·스타일(색, 글꼴, 간격, 모서리)을 뽑아서 표로 정리해줘.",
            "- 프로젝트에 이미 있는 토큰과 같은 값은 짝지어 보여 주고",
            "- 없는 것은 추가할 이름을 제안해줘 (파일은 아직 고치지 마)",
        ],
    },
    {
        id: "connect",
        label: "컴포넌트 연결",
        prompt: [
            "이 Figma 화면의 컴포넌트를 프로젝트의 코드 컴포넌트와 연결해줘 (Code Connect).",
            "- 짝이 되는 코드 컴포넌트를 찾아 목록으로 먼저 보여 주고",
            "- 내가 확인하면 연결해줘",
        ],
    },
];

// 공유 링크에 붙는 추적용 값(t, fuid, share_link_id)은 뺀다 — node-id 같은 뜻 있는 값만 남긴다
const NOISE_PARAMS = ["t", "fuid", "share_link_id"];

export function cleanFigmaUrl(url: string): string {
    try {
        const u = new URL(url);
        for (const p of NOISE_PARAMS) u.searchParams.delete(p);
        return u.toString();
    } catch {
        return url;
    }
}

// 카드 둘째 줄 — "디자인 · 프레임 12:34" / "FigJam · 파일 전체"
export function figmaCardMeta(link: FigmaLink): string {
    return `${link.kindLabel} · ${link.nodeId ? `프레임 ${link.nodeId}` : "파일 전체"}`;
}

export function figmaCardName(link: FigmaLink): string {
    return link.name || `Figma ${link.kindLabel}`;
}

// 빠른 작업으로 채울 글. 입력창에 쓰던 글(링크 말고)은 요청문 뒤에 남긴다 — 아무것도 버리지 않는다.
// 앞서 빠른 작업으로 채운 글 그대로면(lastFill) 그건 버리고 새 요청문으로 바꾼다.
export function figmaActionText(action: FigmaQuickAction, link: FigmaLink, current: string, lastFill: string | null): string {
    const rest = current === lastFill ? "" : current.split(link.url).join("").trim();
    return [...action.prompt, ...(rest ? [rest] : []), cleanFigmaUrl(link.url)].join("\n");
}

// 보낸 메시지에서 카드로 그린 링크 — 링크만 있는 줄은 글에서 뺀다(카드가 대신 보인다). 글 속에 섞인 링크는 그대로.
export function messageFigmaLinks(text: string): {links: FigmaLink[]; text: string} {
    const links = figmaLinksIn(text, 4);
    if (links.length === 0) return {links, text};
    const urls = new Set(links.map((l) => l.url));
    const kept = text.split("\n").filter((line) => {
        const t = line.trim().replace(/^[<(]|[>)]$/g, "");
        return !urls.has(t) && !links.some((l) => t === l.url || cleanFigmaUrl(t) === cleanFigmaUrl(l.url));
    });
    return {links, text: kept.join("\n").trim()};
}
