// 에이전트가 받은 지시를 마크다운으로 그릴 때 쓰는 remark 플러그인 둘 (Markdown의 prompt).
//
// remarkHtmlAsText — HTML 태그를 글자 그대로 보인다. react-markdown은 HTML을 그리지 않고 버린다: 줄 안의 태그는 태그만
// 빠지지만, 태그로 시작하는 덩어리(`<context>` 줄부터 빈 줄까지)는 안의 글까지 통째로 사라진다. 지시는 <context>·<rules>
// 같은 태그로 나눠 쓰는 일이 많아 그러면 내용이 빠진다. 주석(<!-- -->)은 빼고, 줄 안의 <br>은 줄바꿈.
//
// remarkSoftBreaks — 문단 안의 줄바꿈을 그대로 줄바꿈으로. 마크다운은 한 줄로 이어 붙이는데, 지시는 한 줄씩 끊어 쓴
// 글(목록 없이 "파일: …" 줄들)이 많아 이어 붙이면 읽기 어렵다. 답변 쪽은 마크다운 규칙대로 둔다.

interface MdNode {
    type: string;
    value?: string;
    children?: MdNode[];
}

// 글 조각만 담는 노드 — 이 안의 태그는 글자 조각으로, 그 밖(문서·목록 항목·인용)에서는 문단으로 바꾼다
const PHRASING = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell"]);

function linesWithBreaks(value: string): MdNode[] {
    const out: MdNode[] = [];
    value.split("\n").forEach((line, i) => {
        if (i > 0) out.push({type: "break"});
        out.push({type: "text", value: line});
    });
    return out;
}

function htmlAsText(node: MdNode): void {
    if (!node.children) return;
    const inline = PHRASING.has(node.type);
    node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type !== "html") {
            htmlAsText(child);
            return [child];
        }
        const v = child.value ?? "";
        if (/^<!--[\s\S]*-->$/.test(v.trim())) return [];
        if (inline) return /^<br\s*\/?>$/i.test(v.trim()) ? [{type: "break"}] : [{type: "text", value: v}];
        return [{type: "paragraph", children: linesWithBreaks(v)}];
    });
}

function softBreaks(node: MdNode): void {
    if (!node.children) return;
    const inline = PHRASING.has(node.type);
    node.children = node.children.flatMap((child): MdNode[] => {
        if (inline && child.type === "text" && child.value?.includes("\n")) return linesWithBreaks(child.value);
        softBreaks(child);
        return [child];
    });
}

export function remarkHtmlAsText() {
    return (tree: MdNode) => htmlAsText(tree);
}

export function remarkSoftBreaks() {
    return (tree: MdNode) => softBreaks(tree);
}
