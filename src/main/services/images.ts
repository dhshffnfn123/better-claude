import {nativeImage} from "electron";
import fs from "fs";
import path from "path";

// 답변·작업 파일 패널에 보여 줄 그림 파일.
// 확장자와 파일 앞부분(매직 바이트)이 둘 다 그림이어야 그림으로 본다 — 이름만 .png인 다른 파일은 읽지 않는다.
// 위치는 따지지 않는다(Claude가 /tmp·바탕화면에 저장하는 일이 많다). 읽는 것은 그림 바이트뿐이고,
// 화면(렌더러)은 CSP 때문에 밖으로 보낼 길이 없다.

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
// 이보다 작으면 썸네일 = 원본 (움직이는 gif도 그대로)
const THUMB_ORIGINAL_MAX = 1_500_000;
// nativeImage가 못 읽는 형식(svg 등)은 이 크기까지 원본으로
const THUMB_FALLBACK_MAX = 8_000_000;
const THUMB_PX = 640;

export interface ImageFile {
    path: string;
    mime: string;
    size: number;
    mtime: number;
}

export function isImageExt(p: string): boolean {
    return IMAGE_EXTS.has(path.extname(p).slice(1).toLowerCase());
}

// 파일 앞부분으로 형식을 확인한다. svg는 글자 파일이라 앞부분에 <svg 태그가 있어야 한다.
export function sniffImage(head: Buffer, p: string): string | null {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return null;
    const ascii = (a: number, b: number) => head.subarray(a, b).toString("latin1");
    if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
    if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (head.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
    if (ext === "bmp" && ascii(0, 2) === "BM") return "image/bmp";
    if (ext === "ico" && head.length >= 4 && head.readUInt32BE(0) === 0x00000100) return "image/x-icon";
    if (ext === "svg" && /<svg[\s>]/i.test(head.toString("utf8"))) return "image/svg+xml";
    return null;
}

export async function imageFile(abs: string): Promise<ImageFile | null> {
    if (!isImageExt(abs)) return null;
    try {
        const st = await fs.promises.stat(abs);
        if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) return null;
        const fh = await fs.promises.open(abs, "r");
        try {
            const head = Buffer.alloc(Math.min(st.size, 4096));
            await fh.read(head, 0, head.length, 0);
            const mime = sniffImage(head, abs);
            return mime ? {path: abs, mime, size: st.size, mtime: st.mtimeMs} : null;
        } finally {
            await fh.close();
        }
    } catch {
        return null;
    }
}

export async function imageDataUrl(img: ImageFile): Promise<string> {
    const buf = await fs.promises.readFile(img.path);
    return `data:${img.mime};base64,${buf.toString("base64")}`;
}

// 목록에 띄울 작은 그림. full = 원본 그대로(누를 때 다시 읽지 않아도 된다).
// 큰 그림은 줄여서 보낸다 — 고해상도 스크린샷·사진을 통째로 화면에 쌓지 않게.
export async function imageThumbnail(img: ImageFile): Promise<{url: string; full: boolean} | null> {
    if (img.size <= THUMB_ORIGINAL_MAX) return {url: await imageDataUrl(img), full: true};
    const ni = nativeImage.createFromPath(img.path);
    if (!ni.isEmpty()) {
        const {width, height} = ni.getSize();
        const scale = Math.min(1, THUMB_PX / Math.max(width, height, 1));
        const small =
            scale < 1
                ? ni.resize({width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good"})
                : ni;
        return {url: small.toDataURL(), full: false};
    }
    if (img.size <= THUMB_FALLBACK_MAX) return {url: await imageDataUrl(img), full: true};
    return null;
}

// 도구 결과에 든 그림 (Read로 연 그림, MCP 도구의 스크린샷 등).
// Anthropic 모양 {type:"image", source:{type:"base64", media_type, data}} — Read 결과로 확인함 — 과
// MCP 모양 {type:"image", data, mimeType} 둘 다 받는다.
const MAX_RESULT_IMAGES = 4;
const MAX_RESULT_IMAGE_B64 = 14_000_000; // ≈ 10MB

export function toolResultImages(content: unknown): string[] | undefined {
    if (!Array.isArray(content)) return undefined;
    const out: string[] = [];
    for (const c of content as {type?: string; source?: {type?: string; media_type?: string; data?: string}; data?: string; mimeType?: string}[]) {
        if (out.length >= MAX_RESULT_IMAGES) break;
        if (c?.type !== "image") continue;
        const data = c.source ? (c.source.type === "base64" ? c.source.data : undefined) : c.data;
        const mime = c.source?.media_type ?? c.mimeType ?? "image/png";
        if (typeof data !== "string" || !data || data.length > MAX_RESULT_IMAGE_B64) continue;
        if (!/^image\/[\w.+-]+$/.test(mime) || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) continue;
        out.push(`data:${mime};base64,${data}`);
    }
    return out.length > 0 ? out : undefined;
}
