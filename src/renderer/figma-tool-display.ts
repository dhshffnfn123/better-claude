// Figma 도구 줄 꾸미기 — 일반 층(mcp-tool-display.ts)에 등록한다. renderer/main.tsx가 한 번 불러온다.
// "Figma · 디자인 정보 읽기"(Figma 로고) + "노드 1:23" + Figma에서 열기, 쓰기 도구가 만든 보드·파일은 "만든 보드 열기".
import {type FigmaLink, figmaLinksIn, figmaNodeUrl, figmaToolInfo, isFigmaServer, parseFigmaUrl} from "../shared/figma";
import {type McpToolLink, refreshMcpToolDisplays, registerMcpToolDecorator} from "./mcp-tool-display";
import {figmaFeaturesOn, onFigmaFeaturesChange} from "./figma-setting";
import {FigmaLogo} from "./pages/main/FigmaLogo";

function str(v: unknown): string | undefined {
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function short(s: string, max = 60): string {
    const one = s.replace(/\s+/g, " ");
    return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

// 결과 글(앞부분)에 주소 없이 파일 키만 오는 경우 — create_new_file은 file_key를 돌려준다(스킬 문서)
function fileKeyLink(preview: string | undefined, editorType: string | undefined): FigmaLink | undefined {
    const key = preview ? /"?file_?key"?\s*[:=]\s*"([A-Za-z0-9]{6,})"/i.exec(preview)?.[1] : undefined;
    if (!key) return undefined;
    const ed = editorType === "figjam" || editorType === "whiteboard" ? "board" : editorType === "slides" ? "slides" : "design";
    return parseFigmaUrl(`https://www.figma.com/${ed}/${key}`) ?? undefined;
}

// 설정에서 Figma 기능을 끄면 기본 모양("figma · get_screenshot" + 입력 요약)으로 — 모든 탭의 도구 줄이 바로 다시 그려진다
onFigmaFeaturesChange(() => refreshMcpToolDisplays());

registerMcpToolDecorator("figma", ({server, tool, input, resultLinks, resultPreview}) => {
    if (!figmaFeaturesOn() || !isFigmaServer(server)) return null;
    const info = figmaToolInfo(tool);
    const fileKey = str(input.fileKey) ?? str(input.file_key);
    const nodeId = str(input.nodeId) ?? str(input.node_id);
    // 파일 키(Ab12CdEf34)는 사람에게 뜻이 없다 — 노드(프레임) 번호와 무엇을 했는지만
    const parts: string[] = [];
    if (nodeId) parts.push(`노드 ${nodeId}`);
    const query = str(input.query);
    if (query) parts.push(`“${short(query, 40)}”`);
    const named = str(input.fileName) ?? str(input.name) ?? str(input.title);
    if (named) parts.push(short(named, 50));
    const desc = str(input.description) ?? str(input.userIntent);
    if (desc && !named && !query) parts.push(short(desc));

    const links: McpToolLink[] = [];
    if (fileKey) links.push({url: figmaNodeUrl(fileKey, nodeId, info.editor === "board" ? "board" : "design"), label: "Figma에서 열기"});
    // 만든 것의 주소 (새 FigJam 보드·새 파일) — 쓰기 도구만. 읽기 도구 결과에 나온 주소(라이브러리 목록 등)는 "만든 것"이 아니다.
    if (info.kind !== "read") {
        const found = [
            ...(resultLinks ?? []).map((u) => parseFigmaUrl(u)).filter((l): l is FigmaLink => !!l),
            ...figmaLinksIn(resultPreview ?? "", 3),
        ];
        const made =
            found.find((l) => l.fileKey !== fileKey) ??
            (found.length === 0 && !fileKey ? fileKeyLink(resultPreview, str(input.editorType)) : undefined);
        if (made) links.push({url: made.url, label: made.editor === "board" ? "만든 보드 열기" : "만든 파일 열기"});
    }
    return {
        title: `Figma · ${info.label}`,
        detail: parts.join(" · "),
        Icon: FigmaLogo,
        links,
        imageName: nodeId ? `Figma 노드 ${nodeId}` : `Figma ${info.label}`,
    };
});
