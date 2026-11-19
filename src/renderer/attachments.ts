// 첨부·참조 파일을 메시지 글로 만들고(보낼 때) 다시 읽는다(보낸 메시지를 그릴 때).
// Claude에게는 "이 경로들을 읽어 달라"는 글로 가야 해서 메시지 앞에 붙여 보낸다. 화면에서는 그 글을 그대로 보이면
// 지저분해서(안내 문장 + "- /Users/…" 줄들) 내 메시지의 파일 카드로 바꿔 그린다 — 따로 저장하지 않고 글을 다시 읽으므로
// 지금 보낸 메시지와 기록에서 불러온 대화가 같게 보인다. 형식을 바꾸면 parseAttachments도 같이 고친다.

const ATTACH_HEAD = "첨부 파일 — 아래 경로의 파일을 Read 도구로 읽어주세요:";
const MENTION_HEAD = "참조 파일 — 아래 경로를 Read 도구로 읽어주세요:";
const NO_PATH_RE = /^\[첨부\(경로를 확인할 수 없어 읽을 수 없음\): (.*)\]$/;

// 홈 폴더는 ~로 (첨부 카드의 폴더 줄·툴팁)
export function tildePath(p: string): string {
    return p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

export interface AttachmentParts {
    files: string[]; // Finder 등에서 첨부한 파일의 절대 경로
    noPath: string[]; // 경로를 알 수 없어 보내지 못한 첨부의 이름
    mentions: string[]; // @로 넣은 파일 (작업 폴더 기준 상대 경로 또는 절대 경로)
}

export function buildAttachmentText(files: {name: string; path: string}[], mentions: string[]): string[] {
    const parts: string[] = [];
    const withPath = files.filter((f) => f.path);
    const withoutPath = files.filter((f) => !f.path);
    if (withPath.length > 0) parts.push(`${ATTACH_HEAD}\n${withPath.map((f) => `- ${f.path}`).join("\n")}`);
    if (withoutPath.length > 0) parts.push(`[첨부(경로를 확인할 수 없어 읽을 수 없음): ${withoutPath.map((f) => f.name).join(", ")}]`);
    if (mentions.length > 0) parts.push(`${MENTION_HEAD}\n${mentions.map((p) => `- ${p}`).join("\n")}`);
    return parts;
}

// 메시지 앞의 첨부 안내를 떼어 낸다. 안내가 없으면 null — 글은 그대로 그린다.
export function parseAttachments(content: string): {parts: AttachmentParts; text: string} | null {
    const blocks = content.split("\n\n");
    const parts: AttachmentParts = {files: [], noPath: [], mentions: []};
    let i = 0;
    for (; i < blocks.length; i++) {
        const lines = blocks[i].split("\n");
        const head = lines[0];
        const items = lines.slice(1);
        const listed = items.length > 0 && items.every((l) => l.startsWith("- "));
        const noPath = lines.length === 1 ? NO_PATH_RE.exec(head) : null;
        if (head === ATTACH_HEAD && listed) parts.files.push(...items.map((l) => l.slice(2)));
        else if (head === MENTION_HEAD && listed) parts.mentions.push(...items.map((l) => l.slice(2)));
        else if (noPath) parts.noPath.push(...noPath[1].split(", "));
        else break;
    }
    if (i === 0) return null;
    return {parts, text: blocks.slice(i).join("\n\n")};
}
