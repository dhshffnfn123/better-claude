import type {ReactNode} from "react";
import {Children, Fragment, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState} from "react";
import ReactMarkdown, {type Components, defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faChevronDown,
    faChevronRight,
    faClockRotateLeft,
    faCodeBranch,
    faCopy,
    faDownLeftAndUpRightToCenter,
    faPen,
    faRotateLeft,
    faRotateRight,
} from "@fortawesome/free-solid-svg-icons";
import claudeIcon from "../../assets/better-claude-icon.png";
import styles from "./chat.page.module.scss";
import type {CompactSegment, Message, MessageSegment, ToolActivity} from "../../hooks/useClaudeChat";
import {copyText} from "../../clipboard";
import {highlightLanguage} from "../../highlight";
import {editorHint, looksLikeFilePath, openFileRef, resolveFileRef} from "../../file-links";
import {imageRefKey, imageRefsInText, isImagePath, resolveImageRefs} from "../../image-refs";
import {ImageViewerContext, type OpenImage, ReplyLiveContext, TabIdContext} from "../../tab-context";
import {QUESTION_TOOL} from "../../question-answers";
import {remarkHtmlAsText, remarkSoftBreaks} from "../../remark-prompt";
import {isAgentTool, middleTruncate, ToolRow} from "./ActivityPanel";
import {QuestionCard} from "./QuestionCard";
import {BgToggle, CodePreview, HtmlFileCard, htmlFileOf, OpenLargeButton, type PreviewBg, previewKindOf} from "./HtmlPreview";
import {fileBase, iconForFile, iconVars, isImeComposing} from "./ChatInput";
import {Collapsible} from "./Collapsible";
import {MiddleName} from "./MiddleName";
import {type AttachmentParts, parseAttachments, tildePath} from "../../attachments";
import {SkillChip} from "./SkillRef";
import {toolImageName, useMcpDisplayVersion} from "../../mcp-tool-display";

const cx = classNames.bind(styles);

// 복사 버튼: 누르면 잠깐 "복사됨"으로 바뀐다
function useCopied(): [boolean, (text: string) => void] {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | null>(null);
    useEffect(() => () => {
        if (timer.current != null) window.clearTimeout(timer.current);
    }, []);
    const copy = (text: string) => {
        void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
    };
    return [copied, copy];
}

// React 요소 안의 글자만 모은다 (코드 블록의 원래 코드)
function textOf(node: ReactNode): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement<{children?: ReactNode}>(node)) return textOf(node.props.children);
    return "";
}

// 코드 블록(```): 언어 표시 + 복사 버튼 + 문법 색상. 답이 흘러 들어오는 동안에는 글자가 바뀐 블록만 다시 칠한다.
// 긴 내용을 접는 높이 — 코드는 약 19줄, 내 메시지는 약 13줄 (그 1.3배를 넘을 때만 접는다)
const CODE_FOLD_PX = 360;
const USER_FOLD_PX = 300;

function lineCount(text: string): number {
    return text.replace(/\n$/, "").split("\n").length;
}

function CodeBlock({lang, code}: {lang?: string; code: string}) {
    // HTML·SVG 블록은 그려진 모습으로 볼 수 있다(HtmlPreview). 답이 끝나면 미리보기가 기본 — 받는 중에는 블록이
    // 덜 쓰였을 수 있어 코드로 둔다. 사용자가 고른 쪽은 그대로 둔다.
    const kind = useMemo(() => previewKindOf(lang, code), [lang, code]);
    const live = useContext(ReplyLiveContext);
    const [chosen, setChosen] = useState<"preview" | "code" | null>(null);
    const mode = kind ? (chosen ?? (live ? "code" : "preview")) : "code";
    // 배경도 고른 쪽이 없으면 종류에 따라 — 언어 표시 없는 블록은 받는 중에 svg로 바뀔 수 있다
    const [bgChoice, setBg] = useState<PreviewBg | null>(null);
    const bg = bgChoice ?? (kind === "svg" ? "check" : "light");
    const html = useMemo(() => (mode === "code" ? highlightLanguage(code, lang) : ""), [code, lang, mode]);
    const [copied, copy] = useCopied();
    return (
        <div className={cx("codeBlock")}>
            <div className={cx("codeBlockHead")}>
                <span className={cx("codeBlockLang")}>{lang ?? ""}</span>
                {kind && (
                    <span className={cx("codeBlockTabs")}>
                        <button className={cx("codeBlockTab", {codeBlockTabActive: mode === "preview"})} onClick={() => setChosen("preview")}>
                            미리보기
                        </button>
                        <button className={cx("codeBlockTab", {codeBlockTabActive: mode === "code"})} onClick={() => setChosen("code")}>
                            코드
                        </button>
                    </span>
                )}
                <span className={cx("codeBlockSpacer")} />
                {kind && mode === "preview" && <BgToggle bg={bg} onChange={setBg} className={cx("codeBlockTool")} />}
                {kind && (
                    <OpenLargeButton
                        req={kind === "svg" ? {title: "SVG", svg: code} : {title: "HTML", html: code}}
                        className={cx("codeBlockTool")}
                    />
                )}
                <button className={cx("codeBlockCopy")} onClick={() => copy(code)} aria-label="코드 복사">
                    <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                    {copied ? "복사됨" : "복사"}
                </button>
            </div>
            {kind && mode === "preview" ? (
                <CodePreview kind={kind} code={code} bg={bg} live={live} />
            ) : (
                // 길면 접는다 (Collapsible) — highlight.js가 글자를 이스케이프해 만든 HTML이다
                <Collapsible max={CODE_FOLD_PX} label={`전체 보기 · ${lineCount(code)}줄`} toggleClassName="codeCollapseToggle">
                    <pre className={cx("codeBlockPre")}>
                        <code dangerouslySetInnerHTML={{__html: html}} />
                    </pre>
                </Collapsible>
            )}
        </div>
    );
}

// 답변 속 파일 경로 `src/main.ts:120` — 마우스를 올리면 열 수 있는지 알아보고, ⌘+클릭으로 JetBrains IDE에서 연다.
// 그냥 클릭은 글자를 고르는 데 쓰이므로 ⌘가 필요하다(JetBrains의 ⌘+클릭 이동과 같다).
function FileCode({text}: {text: string}) {
    const tabId = useContext(TabIdContext);
    const [target, setTarget] = useState<EditorTarget | null>(null);
    const resolve = () => {
        if (tabId && !target) void resolveFileRef(tabId, text).then(setTarget);
    };
    return (
        <code
            className={cx({pathCode: target?.ok === true})}
            onMouseEnter={resolve}
            onClick={(e) => {
                if (!e.metaKey || !tabId) return;
                e.preventDefault();
                void openFileRef(tabId, text).then(setTarget);
            }}
            data-tooltip={target?.ok ? editorHint(target, true) : undefined}
        >
            {text}
        </code>
    );
}

// 마크다운 파일 링크 [main.ts](src/main.ts#L120) — 그냥 클릭으로 IDE에서 연다 (예전에는 눌러도 아무 일이 없었다)
function FileLink({href, children}: {href: string; children: ReactNode}) {
    const tabId = useContext(TabIdContext);
    const [target, setTarget] = useState<EditorTarget | null>(null);
    return (
        <a
            href={href}
            onMouseEnter={() => {
                if (tabId && !target) void resolveFileRef(tabId, href).then(setTarget);
            }}
            onClick={(e) => {
                e.preventDefault();
                if (tabId) void openFileRef(tabId, href).then(setTarget);
            }}
            data-tooltip={target ? editorHint(target, false) : href}
        >
            {children}
        </a>
    );
}

// 그림 원본 — 썸네일이 줄인 그림이면 main에서 원본을 다시 읽는다
async function fullImageSrc(tabId: string, src: string, path: string | undefined, full: boolean): Promise<string> {
    if (full || !path || !tabId) return src;
    return (await window.electronAPI.readImage(tabId, path)) ?? src;
}

// 마크다운 그림 ![설명](chart.png) — 작업 폴더 기준 경로의 그림을 그 자리에 그린다.
// 웹 그림은 앱이 불러오지 않는다(CSP가 막는다) — 링크로 바꿔 기본 브라우저에서 열게 한다.
function MarkdownImage({src, alt}: {src: string; alt: string}) {
    const tabId = useContext(TabIdContext);
    const openImage = useContext(ImageViewerContext);
    const local = isImagePath(src);
    const [res, setRes] = useState<ResolvedImage | null>(null);
    useEffect(() => {
        if (!local || !tabId) return;
        let alive = true;
        let retry = 0;
        const ask = () => {
            void resolveImageRefs(tabId, [{ref: src}]).then((m) => {
                if (!alive) return;
                const r = m.get(imageRefKey({ref: src})) ?? null;
                setRes(r);
                // 그림보다 글이 먼저 올 수 있다 — 한 번만 다시 본다
                if ((!r || r.ok === false) && retry === 0) retry = window.setTimeout(ask, 2500);
            });
        };
        ask();
        return () => {
            alive = false;
            window.clearTimeout(retry);
        };
    }, [tabId, src, local]);
    if (!local) {
        return /^https?:/i.test(src) ? (
            <a href={src} target="_blank" rel="noreferrer noopener">
                {alt || src}
            </a>
        ) : (
            <span>{alt || src}</span>
        );
    }
    if (!res || res.ok === false || !res.thumb) {
        return (
            <span className={cx("mdImageMissing")} data-tooltip={res ? `그림을 찾을 수 없습니다: ${middleTruncate(src, 80)}` : undefined}>
                {alt || src}
            </span>
        );
    }
    const {thumb, path, full} = res;
    return (
        <img
            className={cx("mdImage")}
            src={thumb}
            alt={alt}
            draggable={false}
            data-tooltip={middleTruncate(path, 90)}
            data-zoomable={openImage ? "" : undefined}
            data-zoom-name={alt || fileBase(path)}
            data-zoom-path={path}
            onClick={(e) => {
                const el = e.currentTarget;
                void fullImageSrc(tabId, thumb, path, !!full).then((u) => openImage?.(u, el));
            }}
        />
    );
}

const MARKDOWN_COMPONENTS: Components = {
    img: ({src, alt}) => <MarkdownImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} />,
    // 웹 링크는 새 창 요청으로 보낸다. main(link-guard)이 기본 브라우저로 연다 — 그냥 두면 앱 창이 그 페이지로 넘어간다.
    // 그 밖의 링크(상대 경로·파일)는 파일로 보고 IDE에서 연다.
    a: ({href, title, children}) => {
        if (href && !/^(https?:|mailto:|#)/i.test(href)) return <FileLink href={href}>{children}</FileLink>;
        return (
            <a href={href} title={title ?? href} target="_blank" rel="noreferrer noopener">
                {children}
            </a>
        );
    },
    // 문장 속 `코드` 중 파일 경로처럼 보이는 것. 코드 블록 안의 code는 아래 pre가 통째로 바꾸므로 여기로 오지 않는다.
    code: ({className, children}) =>
        !className && typeof children === "string" && looksLikeFilePath(children) ? (
            <FileCode text={children} />
        ) : (
            <code className={className}>{children}</code>
        ),
    // 코드 블록만 바꾼다 — 문장 속 `코드`는 <pre> 밖이라 그대로 남는다
    pre: ({children}) => {
        const code = Children.toArray(children)[0];
        if (!isValidElement<{className?: string; children?: ReactNode}>(code)) return <pre>{children}</pre>;
        const lang = /language-([^\s]+)/.exec(code.props.className ?? "")?.[1];
        return <CodeBlock lang={lang} code={textOf(code.props.children).replace(/\n$/, "")} />;
    },
};

// 답변 전체 복사 (마크다운 원문)
function CopyMessageButton({text}: {text: string}) {
    const [copied, copy] = useCopied();
    return (
        <button className={cx("msgActionBtn")} onClick={() => copy(text)} title="이 답변을 마크다운 그대로 복사합니다">
            <FontAwesomeIcon icon={copied ? faCheck : faCopy} /> {copied ? "복사됨" : "복사"}
        </button>
    );
}

// ── 답변 속 그림 ──
// 도구 줄 아래: 도구 결과에 든 그림(Read로 연 그림·스크린샷), 쓰기 도구로 만든 그림 파일, 그 밖의 도구(Bash 등)
// 입출력에 나온 그림 중 그 도구를 부른 뒤에 바뀐 것(ls로 훑은 옛 그림까지 띄우지 않게).
// 글 아래: 글에 나온 그림 경로. 같은 그림은 한 답변에 한 번만 — 만든 도구 쪽이 먼저다.
interface ReplyImage {
    key: string;
    src: string; // 썸네일 (작은 그림은 원본)
    name: string;
    path?: string; // 파일이면 — 썸네일이 줄인 그림일 때 누르면 원본을 다시 읽는다
    full: boolean;
}

interface SegImages {
    images: ReplyImage[];
    omitted: number; // 불러온 대화에서 오래돼 싣지 않은 도구 결과 그림
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Read"]);
const STRIP_MAX = 6;
// 도구를 부른 시각과 파일 수정 시각을 견줄 때의 여유
const SINCE_SLACK_MS = 2000;

function toolFilePath(tool: ToolActivity): string | undefined {
    const fp = (tool.input as {file_path?: unknown} | null)?.file_path;
    return typeof fp === "string" ? fp : undefined;
}

function toolInputText(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    return Object.values(input as Record<string, unknown>)
        .filter((v): v is string => typeof v === "string")
        .join("\n");
}

function baseNameOf(p: string): string {
    return p.slice(p.lastIndexOf("/") + 1) || p;
}

// 세그먼트마다 main에 물어볼 그림 경로
function segmentImageRefs(seg: MessageSegment): ImageRef[] {
    if (seg.kind === "text") return imageRefsInText(seg.text).mentioned.map((ref) => ({ref}));
    if (seg.kind !== "tool") return [];
    const t = seg.tool;
    if (t.name === QUESTION_TOOL || t.status === "running") return [];
    const fp = toolFilePath(t);
    // 결과에 그림이 들어 있으면 그걸 보여 준다 — 경로는 같은 그림을 글 아래에 또 띄우지 않으려고 확인만
    if (t.images?.length || t.imagesOmitted) return fp && isImagePath(fp) ? [{ref: fp, infoOnly: true}] : [];
    if (fp && FILE_TOOLS.has(t.name)) return isImagePath(fp) && t.status === "done" ? [{ref: fp}] : [];
    if (!t.startedAt) return [];
    const since = t.startedAt - SINCE_SLACK_MS;
    return imageRefsInText(`${toolInputText(t.input)}\n${t.resultPreview ?? ""}`).mentioned.map((ref) => ({ref, since}));
}

function useReplyImages(msg: Message, live: boolean): Map<number, SegImages> {
    const tabId = useContext(TabIdContext);
    const segments = msg.role === "assistant" && !msg.greeting ? msg.segments : undefined;
    const bySeg = useMemo(() => (segments ?? []).map(segmentImageRefs), [segments]);
    const refs = useMemo(() => {
        const seen = new Set<string>();
        return bySeg.flat().filter((r) => !seen.has(imageRefKey(r)) && !!seen.add(imageRefKey(r)));
    }, [bySeg]);
    const sig = refs.map(imageRefKey).join("\u0001");
    const [resolved, setResolved] = useState<Map<string, ResolvedImage>>(() => new Map());
    useEffect(() => {
        if (!tabId || refs.length === 0) return;
        let alive = true;
        // 받는 중에는 잠깐 모았다가 묻고, 턴이 끝나면(live → false) 한 번 더 — 그 사이에 생긴 파일
        const timer = window.setTimeout(() => {
            void resolveImageRefs(tabId, refs).then((m) => {
                if (alive) setResolved(m);
            });
        }, live ? 400 : 0);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
        // refs는 sig가 같으면 내용도 같다 — 배열 자체가 아니라 sig로 다시 묻는다
    }, [tabId, sig, live]);

    // 그림 이름이 도구 줄 꾸미기를 따른다(Figma 노드 1:23) — 설정을 바꾸면 다시 짓는다
    const displayVersion = useMcpDisplayVersion();
    return useMemo(() => {
        const out = new Map<number, SegImages>();
        if (!segments) return out;
        const shown = new Set<string>();
        const add = (i: number, image: ReplyImage | null, omitted = 0) => {
            const cur = out.get(i) ?? {images: [], omitted: 0};
            if (image) cur.images.push(image);
            cur.omitted += omitted;
            if (cur.images.length > 0 || cur.omitted > 0) out.set(i, cur);
        };
        const fromRefs = (i: number) => {
            for (const r of bySeg[i] ?? []) {
                const res = resolved.get(imageRefKey(r));
                if (!res || res.ok === false || shown.has(res.path)) continue;
                shown.add(res.path);
                if (r.infoOnly || !res.thumb) continue;
                add(i, {key: res.path, src: res.thumb, name: res.name, path: res.path, full: !!res.full});
            }
        };
        // 도구 먼저: "chart.png를 만들겠습니다"라는 글보다 그 그림을 만든 명령 아래가 제자리다
        segments.forEach((seg, i) => {
            if (seg.kind !== "tool") return;
            const fp = toolFilePath(seg.tool);
            (seg.tool.images ?? []).forEach((src, j) =>
                add(i, {key: `result-${j}`, src, name: fp ? baseNameOf(fp) : toolImageName(seg.tool.name, seg.tool.input), path: fp, full: true})
            );
            if (seg.tool.imagesOmitted) add(i, null, seg.tool.imagesOmitted);
            fromRefs(i);
        });
        segments.forEach((seg, i) => {
            if (seg.kind === "text") fromRefs(i);
        });
        return out;
    }, [segments, bySeg, resolved, displayVersion]);
}

function ImageStrip({images, omitted, indent, onOpen}: SegImages & {indent: boolean; onOpen?: OpenImage}) {
    const tabId = useContext(TabIdContext);
    const [all, setAll] = useState(false);
    const list = all ? images : images.slice(0, STRIP_MAX);
    return (
        <div className={cx("imageStrip", {imageStripIndent: indent})}>
            {list.map((im) => (
                <button
                    key={im.key}
                    className={cx("imageThumb")}
                    data-zoomable={onOpen ? "" : undefined}
                    data-zoom-name={im.name}
                    data-zoom-path={im.path}
                    onClick={(e) => {
                        const el = e.currentTarget;
                        void fullImageSrc(tabId, im.src, im.path, im.full).then((u) => onOpen?.(u, el));
                    }}
                    data-tooltip={middleTruncate(im.path ?? im.name, 90)}
                >
                    {/* 끌어서 놓으면 탭의 파일 놓기로 첨부될 수 있어 막는다 */}
                    <img className={cx("imageThumbImg")} src={im.src} alt="" draggable={false} />
                    <span className={cx("imageThumbName")}>{middleTruncate(im.name, 30)}</span>
                </button>
            ))}
            {!all && images.length > STRIP_MAX && (
                <button className={cx("imageMore")} onClick={() => setAll(true)}>
                    +{images.length - STRIP_MAX}
                </button>
            )}
            {omitted > 0 && <span className={cx("imageOmitted")}>그림 {omitted}개 — 오래된 그림이라 싣지 않았습니다</span>}
        </div>
    );
}

// 내 메시지 — 글 앞에 붙은 첨부 안내("첨부 파일 — …" + 경로 줄들)는 파일 카드로, 긴 글은 접어서 (attachments.ts)
function UserContent({content}: {content: string}) {
    const parsed = useMemo(() => parseAttachments(content), [content]);
    const text = parsed ? parsed.text : content;
    return (
        <>
            {parsed && <AttachmentCards parts={parsed.parts} />}
            {text.trim() && (
                <div className={cx("bubble")}>
                    <Collapsible max={USER_FOLD_PX} label="전체 보기" toggleClassName="bubbleCollapseToggle">
                        {text.split("\n").map((line, i, arr) => (
                            <span key={i}>
                                {line}
                                {i < arr.length - 1 && <br />}
                            </span>
                        ))}
                    </Collapsible>
                </div>
            )}
        </>
    );
}

function AttachmentCards({parts}: {parts: AttachmentParts}) {
    return (
        <div className={cx("attachCards")}>
            {parts.files.map((p) => (
                <AttachmentCard key={`f:${p}`} path={p} kind="file" />
            ))}
            {parts.mentions.map((p) => (
                <AttachmentCard key={`m:${p}`} path={p} kind="mention" />
            ))}
            {parts.noPath.map((n) => (
                <AttachmentCard key={`n:${n}`} path={n} kind="missing" />
            ))}
        </div>
    );
}

// 파일 한 장: 종류별 색 아이콘 + 이름 + 폴더. @로 넣은 파일은 "@" 표시. ⌘+클릭으로 IDE에서 연다(답변 속 경로와 같다).
function AttachmentCard({path, kind}: {path: string; kind: "file" | "mention" | "missing"}) {
    const tabId = useContext(TabIdContext);
    const [target, setTarget] = useState<EditorTarget | null>(null);
    const fi = iconForFile(path);
    const slash = path.lastIndexOf("/");
    const dir = kind === "missing" ? "" : slash > 0 ? tildePath(path.slice(0, slash)) : slash === 0 ? "/" : "";
    const sub = kind === "missing" ? "경로를 알 수 없어 보내지 못했습니다" : dir || "작업 폴더";
    const where = kind === "missing" ? fileBase(path) : tildePath(path);
    return (
        <div
            className={cx("attachCard", {attachCardMissing: kind === "missing"})}
            onMouseEnter={() => {
                if (tabId && !target && kind !== "missing") void resolveFileRef(tabId, path).then(setTarget);
            }}
            onClick={(e) => {
                if (!e.metaKey || !tabId || kind === "missing") return;
                e.preventDefault();
                void openFileRef(tabId, path).then(setTarget);
            }}
            data-tooltip={target?.ok ? `${where} — ${editorHint(target, true)}` : where}
        >
            <span className={cx("attachCardIcon")} style={iconVars(fi)}>
                <FontAwesomeIcon icon={fi.icon} />
            </span>
            <span className={cx("attachCardText")}>
                <span className={cx("attachCardName")}>
                    <MiddleName name={fileBase(path)} />
                </span>
                <span className={cx("attachCardSub")}>
                    {kind === "mention" && <span className={cx("attachCardTag")}>@ 참조</span>}
                    <MiddleName name={sub} />
                </span>
            </span>
        </div>
    );
}

// 대화 압축 — 답변 자리의 구분선. 위쪽 대화가 요약으로 바뀌었다는 표시이고, 요약 본문(CLI가 쓴 영어)은 눌러서 펼친다.
// 기록에서 불러온 대화는 마지막 압축부터만 보이므로(그 앞은 요약 속에만 있다) 맨 위에 "이전 대화 요약"으로 온다.
function CompactDivider({seg}: {seg: CompactSegment}) {
    const [open, setOpen] = useState(false);
    const meta = [
        seg.trigger === "manual" ? "/compact" : seg.trigger === "auto" ? "대화가 길어 자동으로" : null,
        seg.preTokens != null && seg.postTokens != null
            ? `컨텍스트 ${seg.preTokens.toLocaleString()} → ${seg.postTokens.toLocaleString()} 토큰`
            : null,
    ].filter(Boolean);
    return (
        <div className={cx("compactBlock")}>
            <div className={cx("compactRule")}>
                <span className={cx("compactTitle")}>
                    <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} />
                    {seg.restored ? "이전 대화 요약" : "여기까지의 대화를 요약했습니다"}
                </span>
            </div>
            {(meta.length > 0 || seg.summary) && (
                <div className={cx("compactMeta")}>
                    {meta.length > 0 && <span>{meta.join(" · ")}</span>}
                    {seg.summary && (
                        <button className={cx("compactToggle")} onClick={() => setOpen((v) => !v)}>
                            <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} />
                            요약 {open ? "접기" : "보기"}
                        </button>
                    )}
                </div>
            )}
            {/* 마크다운으로 그리지 않는다 — 들여쓰기로 짠 글이라 목록 사이가 크게 벌어진다. 원문 줄바꿈·들여쓰기 그대로. */}
            {open && seg.summary && <div className={cx("compactSummary")}>{seg.summary}</div>}
        </div>
    );
}

interface Props {
    msg: Message;
    isStreaming: boolean;
    isLive?: boolean; // 이 답변을 지금 받는 중 (그림 경로를 턴이 끝날 때 한 번 더 확인한다)
    onImageClick?: OpenImage;
    onRegenerate?: () => void;
    onEditResend?: (text: string) => void;
    onRewindFiles?: (uuid: string) => void;
    // 예전 사용자 메시지의 "여기서 다시" — 이 메시지부터 아래를 버리고 고친 글로 다시 보낸다 (탭 전체에 하나뿐인 함수)
    onRewrite?: (msgId: number, uuid: string, text: string, withFiles: boolean) => void;
    belowCount?: number; // 여기서 다시 하면 버려지는 아래 메시지 수
    onFork?: (replyUuid: string) => void; // 답변의 "여기까지 새 탭으로"
    forking?: boolean;
    onEditingChange?: (msgId: number, editing: boolean) => void; // 고치는 동안 아래 메시지를 흐리게
    dimmed?: boolean;
    onOpenAgent?: (tool: ToolActivity) => void; // 에이전트 줄을 누르면 "에이전트가 한 일" 패널
    // 에이전트 패널에서: 보낸 이 이름(Claude 대신 에이전트 종류), 마지막 글을 "최종 보고"로 표시
    senderLabel?: string;
    markReport?: boolean;
}

type EditMode = "edit" | "rewrite" | null;

// "여기서 다시"를 열면 이 메시지 직전으로 되돌릴 파일이 있는지 미리 본다 (main이 CLI에 dryRun으로 물음)
type RewindPreview = {state: "checking"} | {state: "none"} | {state: "ready"; count: number};

// 마크다운 한 덩어리 — 글이 그대로면 다시 파싱하지 않는다. 스트리밍 중에는 마지막 덩어리만 바뀌고, 응답 시작·끝에
// 모든 메시지가 다시 그려질 때도 파싱은 건너뛴다(예전에는 조각마다 답변 전체를, 턴마다 대화 전체를 다시 파싱했다).
// baseDir: 파일을 그릴 때(작업 파일 패널·지침 패널) 상대 경로 그림·링크를 그 파일이 있는 폴더 기준으로 바꾼다 —
// 그냥 두면 탭의 작업 폴더 기준으로 찾아서, 하위 폴더 README의 `![](docs/a.png)`가 보이지 않았다.
// prompt: 에이전트가 받은 지시 — HTML 태그를 버리지 않고 글자로, 문단 안 줄바꿈은 그대로 (remark-prompt.ts).
const PLUGINS = [remarkGfm];
const PLUGINS_PROMPT = [remarkGfm, remarkHtmlAsText, remarkSoftBreaks];

export const Markdown = memo(function Markdown({text, baseDir, prompt}: {text: string; baseDir?: string; prompt?: boolean}) {
    const urlTransform = useMemo(
        () => (baseDir ? (url: string) => defaultUrlTransform(resolveAgainst(baseDir, url)) : undefined),
        [baseDir]
    );
    return (
        <ReactMarkdown
            remarkPlugins={prompt ? PLUGINS_PROMPT : PLUGINS}
            components={MARKDOWN_COMPONENTS}
            urlTransform={urlTransform}
        >
            {text}
        </ReactMarkdown>
    );
});

// 에이전트가 받은 지시 (백그라운드 패널·에이전트 패널) — 답변과 같은 마크다운으로, 작게. 지시에 흔한 <context> 같은
// 태그는 글자로 남기고(그냥 그리면 태그 덩어리 안의 글까지 사라진다), 한 줄씩 끊어 쓴 줄은 그대로 둔다.
export function PromptMarkdown({text}: {text: string}) {
    return (
        <div className={cx("bubble", "markdown", "promptMarkdown")}>
            <Markdown text={text} prompt />
        </div>
    );
}

// 상대 경로만 baseDir 기준 절대 경로로 (웹 주소·절대 경로·#앵커·~ 는 그대로)
function resolveAgainst(baseDir: string, url: string): string {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/") || url.startsWith("#") || url.startsWith("~")) return url;
    const cut = url.search(/[?#]/);
    const pathPart = cut >= 0 ? url.slice(0, cut) : url;
    const rest = cut >= 0 ? url.slice(cut) : "";
    let decoded = pathPart;
    try {
        decoded = decodeURI(pathPart);
    } catch {
        // 잘못된 %표기 — 그대로 쓴다
    }
    const out: string[] = [];
    for (const seg of `${baseDir}/${decoded}`.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
    }
    return "/" + out.join("/") + rest;
}

function MessageItemBase({
    msg,
    isStreaming,
    isLive = false,
    onImageClick,
    onRegenerate,
    onEditResend,
    onRewindFiles,
    onRewrite,
    belowCount = 0,
    onFork,
    forking = false,
    onEditingChange,
    dimmed = false,
    onOpenAgent,
    senderLabel,
    markReport = false,
}: Props) {
    const tabId = useContext(TabIdContext);
    const [editing, setEditing] = useState<EditMode>(null);
    const replyImages = useReplyImages(msg, isLive);
    const [draft, setDraft] = useState(msg.content);
    const [rewindPreview, setRewindPreview] = useState<RewindPreview>({state: "none"});
    const [withFiles, setWithFiles] = useState(false); // 기본은 끔 — 파일은 직접 고를 때만 되돌린다

    useEffect(() => {
        onEditingChange?.(msg.id, editing !== null);
    }, [editing, msg.id, onEditingChange]);

    const startEdit = (mode: Exclude<EditMode, null>) => {
        setDraft(msg.content);
        setEditing(mode);
        if (mode !== "rewrite" || !msg.uuid || !tabId) return;
        setWithFiles(false);
        setRewindPreview({state: "checking"});
        const uuid = msg.uuid;
        void window.electronAPI
            .rewindFiles(tabId, uuid, true)
            .then((r) => setRewindPreview(r.canRewind && (r.filesChanged?.length ?? 0) > 0 ? {state: "ready", count: r.filesChanged?.length ?? 0} : {state: "none"}))
            .catch(() => setRewindPreview({state: "none"}));
    };

    const saveEdit = () => {
        const t = draft.trim();
        if (!t) return;
        if (editing === "rewrite") {
            if (msg.uuid) onRewrite?.(msg.id, msg.uuid, t, withFiles && rewindPreview.state === "ready");
        } else {
            onEditResend?.(t);
        }
        setEditing(null);
    };

    // 압축 구분선도 "보이는 내용" — 그 아래에 생각 중 점이 남지 않게
    const hasVisibleText =
        msg.segments?.some((s) => (s.kind === "text" && s.text.trim().length > 0) || s.kind === "compact") ?? false;
    const hasCompact = msg.segments?.some((s) => s.kind === "compact") ?? false;
    // 에이전트 패널: 마지막 글 = 에이전트가 메인 Claude에게 돌려준 보고
    const lastTextIdx = markReport
        ? (msg.segments ?? []).reduce((last, sg, i) => (sg.kind === "text" && sg.text.trim() ? i : last), -1)
        : -1;
    // /compact의 답처럼 구분선뿐인 답변 — 다시 생성할 것이 없다
    const compactOnly = hasCompact && (msg.segments?.every((s) => s.kind === "compact") ?? false);
    const showRegenerate = !!onRegenerate && msg.role === "assistant" && !compactOnly;
    // 다 받은 답변만 복사할 수 있다 (첫 인사말 제외)
    const canCopy = msg.role === "assistant" && !msg.greeting && !isStreaming && msg.content.trim().length > 0;
    // 갈라낸 대화로 복사된 메시지는 파일 되돌리기 기록이 없다 (SDK가 복사하지 않는다)
    const showRewindFiles = !!onRewindFiles && !!msg.uuid && msg.role === "user" && !msg.copied;
    const showRewrite = !!onRewrite && !!msg.uuid && msg.role === "user";
    const showFork = !!onFork && !!msg.replyUuid && msg.role === "assistant" && !msg.greeting && !compactOnly;
    return (
        // data-msg-id·data-role: 탭 화면이 "지금 읽는 답변"을 찾는 데 쓴다 (답변 처음으로 버튼)
        // dimmed: 위 메시지를 고치는 중 — 보내면 버려질 메시지
        <ReplyLiveContext.Provider value={isLive}>
        <div
            className={cx("messageWrapper", msg.role, {messageDimmed: dimmed})}
            data-msg-id={msg.id}
            data-role={msg.role}
            data-greeting={msg.greeting ? "" : undefined}
        >
            {/* 구분선이 든 답변은 폭을 끝까지 쓴다 — 내용 폭에 맞춰 줄면 구분선이 짧게 끊긴다 */}
            <div className={cx("messageInner", {messageInnerWide: hasCompact})}>
                <div className={cx("sender")}>
                    {msg.role === "assistant" && (
                        <img src={claudeIcon} className={cx("senderIcon")} alt="" />
                    )}
                    {msg.role === "user" ? "나" : senderLabel ?? "Claude"}
                    {/* 0은 띄우지 않는다 — /compact·/cost처럼 모델이 답하지 않은 턴 */}
                    {msg.role === "user" && !!msg.inputTokens && (
                        <span className={cx("tokenBadge")}>{msg.inputTokens.toLocaleString()} tokens</span>
                    )}
                    {msg.role === "assistant" && !!msg.outputTokens && (
                        <span className={cx("tokenBadge")}>{msg.outputTokens.toLocaleString()} tokens</span>
                    )}
                </div>
                {msg.images && msg.images.length > 0 && (
                    <div className={cx("messageBubbleImages")}>
                        {msg.images.map((src, i) => (
                            <img
                                key={i}
                                src={src}
                                className={cx("messageBubbleImage")}
                                alt=""
                                data-zoomable={onImageClick ? "" : undefined}
                                data-zoom-name="첨부한 그림"
                                onClick={(e) => onImageClick?.(src, e.currentTarget)}
                            />
                        ))}
                    </div>
                )}
                {msg.role === "user" ? (
                    editing ? (
                        <div className={cx("editBox")}>
                            <textarea
                                className={cx("editTextarea")}
                                value={draft}
                                autoFocus
                                rows={Math.min(draft.split("\n").length + 1, 10)}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (isImeComposing(e)) return;
                                    if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        saveEdit();
                                    }
                                    if (e.key === "Escape") setEditing(null);
                                }}
                            />
                            {editing === "rewrite" && (
                                <div className={cx("rewriteNote")}>
                                    <span>
                                        보내면 여기서부터 다시 시작합니다
                                        {belowCount > 0 ? ` — 아래 메시지 ${belowCount}개는 버려지고 Claude도 기억하지 않습니다` : ""}.
                                    </span>
                                    {rewindPreview.state === "checking" && (
                                        <span className={cx("rewriteFilesChecking")}>되돌릴 파일이 있는지 확인하는 중…</span>
                                    )}
                                    {rewindPreview.state === "ready" && (
                                        <label className={cx("rewriteFiles")}>
                                            <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
                                            파일도 이 메시지를 보내기 직전으로 되돌리기 (Claude가 고친 파일 {rewindPreview.count}개)
                                        </label>
                                    )}
                                </div>
                            )}
                            <div className={cx("editActions")}>
                                <button className={cx("editBtn")} onClick={() => setEditing(null)}>
                                    취소
                                </button>
                                <button className={cx("editBtn", "editBtnPrimary")} onClick={saveEdit}>
                                    {editing === "rewrite" ? "여기서 다시 보내기" : "보내기"}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* /스킬이름으로 부른 메시지 — 그 스킬을 확장 창에서 보는 표시 (글은 그대로) */}
                            <SkillChip content={msg.content} />
                            <UserContent content={msg.content} />
                        </>
                    )
                ) : msg.segments && msg.segments.length > 0 ? (
                    // 어시스턴트: 텍스트 말풍선과 도구를 발생 순서대로 분리 렌더
                    <div className={cx("segmentList")}>
                        {msg.segments.map((seg, i) => {
                            const images = replyImages.get(i);
                            return (
                                <Fragment key={seg.kind === "tool" ? seg.tool.id : i}>
                                    {seg.kind === "compact" ? (
                                        <CompactDivider seg={seg} />
                                    ) : seg.kind === "tool" ? (
                                        seg.tool.name === QUESTION_TOOL ? (
                                            <QuestionCard tool={seg.tool} />
                                        ) : (
                                            <ToolRow
                                                tool={seg.tool}
                                                defaultExpanded
                                                onOpen={onOpenAgent && isAgentTool(seg.tool.name) ? () => onOpenAgent(seg.tool) : undefined}
                                            />
                                        )
                                    ) : seg.text.trim() ? (
                                        <div className={cx("bubble", "markdown")}>
                                            {markReport && i === lastTextIdx && <div className={cx("agentReportLabel")}>최종 보고</div>}
                                            <Markdown text={seg.text} />
                                        </div>
                                    ) : null}
                                    {images && <ImageStrip {...images} indent={seg.kind === "tool"} onOpen={onImageClick} />}
                                    {seg.kind === "tool" && htmlFileOf(seg.tool) && <HtmlFileCard path={htmlFileOf(seg.tool) as string} />}
                                </Fragment>
                            );
                        })}
                        {isStreaming && !hasVisibleText && (
                            <div className={cx("bubble", "markdown")}>
                                <span className={cx("thinking")}>
                                    <span />
                                    <span />
                                    <span />
                                </span>
                            </div>
                        )}
                    </div>
                ) : (
                    // segments 없는 경우(불러온 대화, 응답 시작 직전)
                    <div className={cx("bubble", "markdown")}>
                        {isStreaming && !msg.content ? (
                            <span className={cx("thinking")}>
                                <span />
                                <span />
                                <span />
                            </span>
                        ) : (
                            <Markdown text={msg.content} />
                        )}
                    </div>
                )}
                {(showRegenerate || showRewindFiles || onEditResend || canCopy || showRewrite || showFork) && !editing && (
                    <div className={cx("msgActions")}>
                        {canCopy && <CopyMessageButton text={msg.content} />}
                        {onEditResend && !editing && msg.role === "user" && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => startEdit("edit")}
                                title="이 메시지를 고쳐서 다시 보냅니다. 기존 답변은 버려지고, 그 답변이 고친 파일은 그대로 남습니다"
                            >
                                <FontAwesomeIcon icon={faPen} /> 편집
                            </button>
                        )}
                        {showRewindFiles && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => msg.uuid && onRewindFiles?.(msg.uuid)}
                                title="이 메시지를 보내기 직전 상태로, Claude가 Write·Edit 도구로 고친 파일을 되돌립니다 (대화는 그대로)"
                            >
                                <FontAwesomeIcon icon={faClockRotateLeft} /> 파일 되돌리기
                            </button>
                        )}
                        {showRewrite && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={() => startEdit("rewrite")}
                                title="이 메시지부터 다시 씁니다. 아래 대화는 버려지고 Claude도 기억하지 않습니다 (파일은 고를 때만 되돌림)"
                            >
                                <FontAwesomeIcon icon={faRotateLeft} /> 여기서 다시
                            </button>
                        )}
                        {showRegenerate && (
                            <button
                                className={cx("msgActionBtn")}
                                onClick={onRegenerate}
                                title="이 답변을 버리고 다시 생성합니다. 이 답변이 고친 파일은 그대로 남습니다 (필요하면 먼저 '파일 되돌리기')"
                            >
                                <FontAwesomeIcon icon={faRotateRight} /> 재생성
                            </button>
                        )}
                        {showFork && (
                            <button
                                className={cx("msgActionBtn")}
                                disabled={forking}
                                onClick={() => msg.replyUuid && onFork?.(msg.replyUuid)}
                                title="이 답변까지의 대화를 복사해 새 탭에서 이어 갑니다. 원래 대화는 그대로입니다 (작업 폴더는 같아서 같은 파일을 고치면 서로 덮어씁니다)"
                            >
                                <FontAwesomeIcon icon={faCodeBranch} /> {forking ? "갈라내는 중…" : "여기까지 새 탭으로"}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
        </ReplyLiveContext.Provider>
    );
}

export const MessageItem = memo(MessageItemBase);
