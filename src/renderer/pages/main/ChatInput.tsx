import type {ComponentProps, CSSProperties, ReactNode} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCircleInfo,
    faClock,
    faFile,
    faFileCode,
    faFileCsv,
    faFileImage,
    faFileLines,
    faFilePdf,
    faFileZipper,
    faFolder,
    faGear,
    faLock,
    faPaperclip,
    faPaperPlane,
    faPlus,
    faStop,
    faTerminal,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import {
    faCss3Alt,
    faHtml5,
    faJs,
    faMarkdown,
    faPython,
    faReact,
    faRust,
    faSass,
} from "@fortawesome/free-brands-svg-icons";
import type {IconDefinition} from "@fortawesome/fontawesome-svg-core";
import styles from "./chat.page.module.scss";
import type {ImagePayload, TurnEnd} from "../../hooks/useClaudeChat";
import {readFileAsImagePayload} from "../../hooks/useClaudeChat";
import {onTab} from "../../tab-events";
import {useSuggestionsEnabled} from "../../suggestion-setting";
import {buildAttachmentText, tildePath} from "../../attachments";
import {MiddleName} from "./MiddleName";
import {useLightbox} from "./Lightbox";
import {classifySlash, filterMenu, type MenuCommand, menuCommands, type SlashResult, unknownNotice} from "../../slash-commands";

const cx = classNames.bind(styles);

// 커서 바로 앞에 입력 중인 @토큰을 찾는다. 공백/줄바꿈/다른 @가 나오면 멘션이 아니다.
function detectMention(text: string, cursor: number): {query: string; start: number} | null {
    const upto = text.slice(0, cursor);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    const query = m[1];
    return {query, start: cursor - query.length - 1};
}

export const fileBase = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const fileDir = (p: string) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
};

// 확장자별 아이콘 + 색상. 없으면 기본 파일 아이콘.
// dark: 다크 모드에서 바탕에 묻히는 색만 따로 (없으면 color 그대로)
interface FileIcon {
    icon: IconDefinition;
    color: string;
    dark?: string;
}

const FILE_ICONS: Record<string, FileIcon> = {
    ts: {icon: faFileCode, color: "#3178c6", dark: "#5b9be6"},
    tsx: {icon: faReact, color: "#61dafb"},
    js: {icon: faJs, color: "#f7df1e"},
    jsx: {icon: faReact, color: "#61dafb"},
    mjs: {icon: faJs, color: "#f7df1e"},
    cjs: {icon: faJs, color: "#f7df1e"},
    json: {icon: faFileCode, color: "#cbab38"},
    scss: {icon: faSass, color: "#cd6799"},
    sass: {icon: faSass, color: "#cd6799"},
    css: {icon: faCss3Alt, color: "#2965f1", dark: "#6b9bf5"},
    html: {icon: faHtml5, color: "#e34f26"},
    md: {icon: faMarkdown, color: "#3a3d35", dark: "var(--c-text)"},
    markdown: {icon: faMarkdown, color: "#3a3d35", dark: "var(--c-text)"},
    py: {icon: faPython, color: "#3776ab", dark: "#5b9bd5"},
    rs: {icon: faRust, color: "#b7410e", dark: "#e0743c"},
    png: {icon: faFileImage, color: "#7e8c6a"},
    jpg: {icon: faFileImage, color: "#7e8c6a"},
    jpeg: {icon: faFileImage, color: "#7e8c6a"},
    gif: {icon: faFileImage, color: "#7e8c6a"},
    webp: {icon: faFileImage, color: "#7e8c6a"},
    svg: {icon: faFileImage, color: "#7e8c6a"},
    pdf: {icon: faFilePdf, color: "#e5252a"},
    csv: {icon: faFileCsv, color: "#1d6f42", dark: "#4fb07c"},
    zip: {icon: faFileZipper, color: "#a8a99a"},
    gz: {icon: faFileZipper, color: "#a8a99a"},
    tar: {icon: faFileZipper, color: "#a8a99a"},
    tgz: {icon: faFileZipper, color: "#a8a99a"},
    txt: {icon: faFileLines, color: "#8a8f7a"},
    log: {icon: faFileLines, color: "#8a8f7a"},
    yml: {icon: faGear, color: "#8a8f7a"},
    yaml: {icon: faGear, color: "#8a8f7a"},
    toml: {icon: faGear, color: "#8a8f7a"},
    env: {icon: faGear, color: "#8a8f7a"},
    ini: {icon: faGear, color: "#8a8f7a"},
    conf: {icon: faGear, color: "#8a8f7a"},
    sh: {icon: faTerminal, color: "#3a3d35", dark: "var(--c-text)"},
    bash: {icon: faTerminal, color: "#3a3d35", dark: "var(--c-text)"},
    zsh: {icon: faTerminal, color: "#3a3d35", dark: "var(--c-text)"},
    lock: {icon: faLock, color: "#a8a99a"},
};

const DEFAULT_FILE_ICON: FileIcon = {icon: faFile, color: "#c9a84c"};

// 색은 CSS 변수로 넘기고 실제 칠은 .mentionIcon/.mentionChipIcon이 테마에 맞춰 한다.
// FontAwesomeIcon의 style 타입은 자기 변수(--fa-*)만 알아서 한 번 풀어서 넘긴다.
// 아이콘이 아닌 상자(첨부 카드의 색 네모)에 같은 색 변수를 넘길 때
export function iconVars(fi: FileIcon): CSSProperties {
    const vars: Record<string, string> = {"--icon": fi.color};
    if (fi.dark) vars["--icon-dark"] = fi.dark;
    return vars as CSSProperties;
}

export function iconStyle(fi: FileIcon): ComponentProps<typeof FontAwesomeIcon>["style"] {
    const vars: Record<string, string> = {"--icon": fi.color};
    if (fi.dark) vars["--icon-dark"] = fi.dark;
    return vars as unknown as ComponentProps<typeof FontAwesomeIcon>["style"];
}

// 한글처럼 조합해서 입력하는 중인 키 입력인가. 마지막 글자를 조합하는 중에 Enter를 누르면
// 브라우저가 Enter를 두 번 보낸다(조합 중 표시가 붙은 것 → 확정 후 진짜 Enter). 첫 번째에 반응하면
// 확정 전 내용을 보내고 마지막 글자가 입력칸에 남는다. keyCode 229는 조합 중을 뜻하는 예전 표시.
export function isImeComposing(e: React.KeyboardEvent): boolean {
    return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function iconForFile(p: string): FileIcon {
    const base = fileBase(p);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    return FILE_ICONS[ext] ?? DEFAULT_FILE_ICON;
}

// 입력창의 내용 전체 (글 + 첨부). 응답 중에 보내면 이 모양 그대로 줄 세워 둔다.
interface Draft {
    input: string;
    images: ImagePayload[];
    files: {name: string; path: string}[];
    mentions: string[];
}

const EMPTY_DRAFT: Draft = {input: "", images: [], files: [], mentions: []};

function isEmptyDraft(d: Draft): boolean {
    return !d.input.trim() && d.images.length === 0 && d.files.length === 0 && d.mentions.length === 0;
}

// 둘을 하나로 — 대기 중인 메시지에 더 보태거나, 되돌릴 때 입력창에 쓰던 글과 합칠 때
function mergeDrafts(a: Draft, b: Draft): Draft {
    const input = a.input.trim() && b.input.trim() ? `${a.input.trimEnd()}\n\n${b.input.trimStart()}` : a.input.trim() ? a.input : b.input;
    return {
        input,
        images: [...a.images, ...b.images],
        files: [...a.files, ...b.files],
        mentions: [...a.mentions, ...b.mentions.filter((m) => !a.mentions.includes(m))],
    };
}

// 첨부·참조 파일 안내를 글 앞에 붙여 실제로 보낼 메시지를 만든다 (형식은 attachments.ts — 보낸 메시지에서 다시 읽어 카드로 그린다)
function buildMessage(d: Draft): {text: string; images: ImagePayload[]} {
    const parts = buildAttachmentText(d.files, d.mentions);
    const trimmed = d.input.trim();
    if (trimmed) parts.push(trimmed);
    return {text: parts.join("\n\n"), images: d.images};
}

// 대기 중인 메시지 미리보기: 첫 줄 + 첨부 개수
function draftPreview(d: Draft): string {
    const firstLine = d.input.trim().split("\n")[0] ?? "";
    const attached = d.images.length + d.files.length + d.mentions.length;
    return [firstLine, attached > 0 ? `첨부 ${attached}개` : ""].filter(Boolean).join(" · ");
}

interface Props {
    // 이 입력창이 속한 탭 — 명령 목록·@멘션 파일 검색은 그 탭의 작업 폴더 기준이다
    tabId: string;
    // 보고 있는 탭이면 true. 탭으로 돌아오면 입력칸에 커서를 둔다.
    active: boolean;
    isLoading: boolean;
    onSend: (message: string, images: ImagePayload[]) => void;
    onStop: () => void;
    // 턴이 끝날 때마다 바뀐다 — 대기 중인 메시지를 보낼지(정상 종료) 되돌릴지(중지) 정한다
    turnEnd: TurnEnd;
    // 다른 대화로 옮기면 바뀐다 — 대기 중인 메시지를 새 대화로 보내지 않고 입력창으로 되돌린다
    resetSignal: number;
    promptHooks?: PromptHooks;
    // 탭 화면에 끌어다 놓은 파일을 붙이는 함수를 넘긴다 (빠질 때 null)
    onRegisterAddFiles?: (add: ((files: File[]) => void) | null) => void;
    // 작업 파일 패널에서 끌어 온 파일을 @로 넣는다 (ChatTabView가 받는다)
    onRegisterAddMention?: (add: ((path: string) => void) | null) => void;
    // 글과 그림을 입력창에 넣는 함수를 넘긴다 — 화면 대조의 "차이 고쳐 달라고 하기" (보내지는 않는다)
    onRegisterFill?: (fill: ((text: string, images: ImagePayload[]) => void) | null) => void;
    // 답변이 끝난 뒤 CLI가 짐작한 다음 요청 — 입력창이 비어 있으면 흐리게 보이고 Tab으로 채운다
    suggestion?: string | null;
    onSuggestionUsed?: () => void;
    // 입력창 바로 위에 붙일 것 — 백그라운드 작업 줄
    top?: ReactNode;
    // 슬래시 명령 중 CLI로 보내지 않는 것 — 앱이 하는 것(/model, /clear …)은 탭 바깥이, 알림(터미널 전용·없는 명령)은 탭이 한다
    onSlashCommand?: (r: Extract<SlashResult, {kind: "app" | "notice"}>) => void;
}

// 시스템 프롬프트 추가·삭제 전후에 셸이 할 일: confirm = 계속할지(백그라운드 작업이 꺼질 수 있다), changed = 탭마다 안내
export interface PromptHooks {
    confirm: () => boolean;
    changed: () => void;
}

export function ChatInput({
    tabId,
    active,
    isLoading,
    onSend,
    onStop,
    turnEnd,
    resetSignal,
    promptHooks,
    onRegisterAddFiles,
    onRegisterAddMention,
    onRegisterFill,
    suggestion,
    onSuggestionUsed,
    top,
    onSlashCommand,
}: Props) {
    const [suggestOn] = useSuggestionsEnabled();
    const [input, setInput] = useState("");
    const [selectedImages, setSelectedImages] = useState<ImagePayload[]>([]);
    const [selectedFiles, setSelectedFiles] = useState<{name: string; path: string}[]>([]);
    // 입력창 위 첨부 그림 크게 보기 (앞뒤 넘기기 범위 = 첨부 줄)
    const attachStripRef = useRef<HTMLDivElement>(null);
    const {open: openAttached, lightbox: attachedLightbox} = useLightbox(attachStripRef, tabId);
    const [prompts, setPrompts] = useState<string[]>([]);
    const [promptInputOpen, setPromptInputOpen] = useState(false);
    const [newPromptInput, setNewPromptInput] = useState("");
    const [commands, setCommands] = useState<SlashCommand[]>([]);
    const [commandsOpen, setCommandsOpen] = useState(false);
    const [activeCommand, setActiveCommand] = useState(0);
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionFiles, setMentionFiles] = useState<string[]>([]);
    const [activeMention, setActiveMention] = useState(0);
    const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);
    const [queued, setQueued] = useState<Draft | null>(null);
    // 목록에 없는 명령을 쳤다 — CLI에 목록을 다시 묻는 중 (그동안 Enter는 받지 않는다)
    const [checkingCommand, setCheckingCommand] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const resizeFrameRef = useRef<number | null>(null);
    const mentionStartRef = useRef(-1);
    const pendingCursorRef = useRef<number | null>(null);
    const activeMentionRef = useRef<HTMLDivElement>(null);
    // "지금 보내기": 중지로 끝난 턴이어도 대기 메시지를 되돌리지 않고 바로 보낸다
    const sendAfterStopRef = useRef(false);
    const seenTurnEndRef = useRef(turnEnd.seq);
    const seenResetRef = useRef(resetSignal);
    // 명령 목록을 다시 묻는 동안 바뀐 것 — 답이 온 뒤 최신 값으로 판단한다
    const latestRef = useRef({input, isLoading, onSend, onSlashCommand});
    latestRef.current = {input, isLoading, onSend, onSlashCommand};

    useEffect(() => {
        window.electronAPI.listCommands(tabId).then(setCommands);
        // 작업 폴더가 바뀌거나 CLI가 새 스킬을 찾으면 목록이 다시 온다
        return onTab("commands", tabId, setCommands);
    }, [tabId]);

    // 시스템 프롬프트는 모든 탭이 같이 쓴다 — 다른 탭에서 바꿨을 수 있어 탭으로 돌아올 때마다 다시 읽는다.
    // 돌아오면 바로 이어 쓸 수 있게 입력칸에 커서를 둔다.
    useEffect(() => {
        if (!active) return;
        window.electronAPI.getPrompts().then(setPrompts);
        textareaRef.current?.focus();
    }, [active]);

    // "/" 메뉴 = CLI 목록 + 앱이 아는 명령(앱·터미널 표시). 친 이름과 정확히 같은 것이 맨 위다.
    const menu = useMemo(() => menuCommands(commands), [commands]);
    const filteredCommands = useMemo(() => (commandsOpen ? filterMenu(menu, input) : []), [menu, input, commandsOpen]);

    useEffect(() => {
        setActiveCommand(0);
    }, [input, commandsOpen]);

    useEffect(() => {
        return () => {
            if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
        };
    }, []);

    // 화살표로 활성 항목이 바뀌면 드롭다운을 따라 스크롤
    useEffect(() => {
        activeMentionRef.current?.scrollIntoView({block: "nearest"});
    }, [activeMention, mentionOpen]);

    // 멘션 삽입 후 커서를 삽입된 토큰 끝으로 이동
    useEffect(() => {
        if (pendingCursorRef.current != null && textareaRef.current) {
            const pos = pendingCursorRef.current;
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(pos, pos);
            pendingCursorRef.current = null;
        }
    }, [input]);

    // 멘션 선택 → textarea의 @토큰은 지우고 칩으로 추가
    const addMention = (filePath: string) => {
        const cursor = textareaRef.current?.selectionStart ?? input.length;
        const start = mentionStartRef.current;
        if (start < 0) return;
        const before = input.slice(0, start);
        const after = input.slice(cursor);
        setInput(before + after);
        setMentionedFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
        setMentionOpen(false);
        setMentionFiles([]);
        pendingCursorRef.current = before.length;
    };

    const removeMention = (filePath: string) => {
        setMentionedFiles((prev) => prev.filter((p) => p !== filePath));
    };

    const resetTextareaHeight = () => {
        if (textareaRef.current) textareaRef.current.style.height = "44px";
    };

    // 내용에 맞춰 입력창 높이를 다시 잰다. scrollHeight 읽기는 강제 reflow를 유발하므로 rAF로 디퍼
    const scheduleResize = useCallback(() => {
        if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.style.height = "44px";
            // box-sizing이 border-box라 scrollHeight에 테두리를 더해야 한다 — 빼먹으면 늘 2px가 넘쳐 스크롤바가 보였다
            el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
            resizeFrameRef.current = null;
        });
    }, []);

    // 바깥에서 넣은 글(화면 대조) — 그려진 뒤 높이를 맞춘다. 미리 재면 옛 글 높이라 두 줄째가 가려졌다.
    const resizeAfterFillRef = useRef(false);
    useEffect(() => {
        if (!resizeAfterFillRef.current) return;
        resizeAfterFillRef.current = false;
        scheduleResize();
    }, [input, scheduleResize]);

    const clearDraft = () => {
        setInput("");
        setSelectedImages([]);
        setSelectedFiles([]);
        setMentionedFiles([]);
        setMentionOpen(false);
        resetTextareaHeight();
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    // 대기 메시지를 입력창으로 되돌린다. 그사이 입력창에 쓰던 글이 있으면 그 앞에 붙인다 — 아무것도 버리지 않는다.
    const restoreDraft = useCallback(
        (q: Draft) => {
            setInput((cur) => mergeDrafts(q, {...EMPTY_DRAFT, input: cur}).input);
            setSelectedImages((cur) => [...q.images, ...cur]);
            setSelectedFiles((cur) => [...q.files, ...cur]);
            setMentionedFiles((cur) => [...q.mentions, ...cur.filter((m) => !q.mentions.includes(m))]);
            scheduleResize();
            textareaRef.current?.focus();
        },
        [scheduleResize]
    );

    // 응답 중이면 바로 보내지 않고 줄 세워 둔다. 여러 번 보내면 하나로 이어 붙는다.
    const queueDraft = (d: Draft) => {
        setQueued((q) => (q ? mergeDrafts(q, d) : d));
        clearDraft();
    };

    // 슬래시 명령: 앱이 하는 것·터미널 전용·없는 명령은 CLI로 보내지 않는다(slash-commands.ts). 여기서 맡았으면 true.
    // 목록에 없는 이름은 목록을 새로 받아 한 번 더 본다 — 터미널에서 방금 설치한 플러그인·방금 만든 스킬일 수 있다.
    const handleSlash = (text: string): boolean => {
        if (!onSlashCommand) return false;
        const r = classifySlash(text, commands);
        if (r.kind === "cli") return false;
        if (r.kind !== "unknown") {
            onSlashCommand(r);
            clearDraft();
            return true;
        }
        setCheckingCommand(true);
        const decide = (fresh: SlashCommand[] | null) => {
            setCheckingCommand(false);
            const again = fresh ? classifySlash(text, fresh) : ({kind: "cli"} as const);
            const latest = latestRef.current;
            const unchanged = latest.input === text;
            if (again.kind === "unknown") {
                // 고쳐 쓸 수 있게 입력창은 그대로 둔다
                latest.onSlashCommand?.({kind: "notice", notice: unknownNotice(again.name, again.args)});
                return;
            }
            if (again.kind !== "cli") {
                latest.onSlashCommand?.(again);
            } else if (latest.isLoading) {
                setQueued((q) => (q ? mergeDrafts(q, {...EMPTY_DRAFT, input: text}) : {...EMPTY_DRAFT, input: text}));
            } else {
                latest.onSend(text.trim(), []);
            }
            if (unchanged) clearDraft();
        };
        window.electronAPI.listCommands(tabId, true).then(
            (fresh) => {
                setCommands(fresh);
                decide(fresh);
            },
            // 묻지 못했으면 CLI에 맡긴다 (모르는 명령이면 CLI가 Claude에게 글로 넘긴다)
            () => decide(null)
        );
        return true;
    };

    const handleSend = () => {
        const draft: Draft = {input, images: selectedImages, files: selectedFiles, mentions: mentionedFiles};
        if (isEmptyDraft(draft) || checkingCommand) return;
        // 첨부 없이 "/"로 시작하면 명령이다 (첨부가 있으면 그 안내가 앞에 붙어 CLI도 명령으로 보지 않는다)
        if (draft.images.length === 0 && draft.files.length === 0 && draft.mentions.length === 0 && handleSlash(draft.input)) return;
        if (isLoading) {
            queueDraft(draft);
            return;
        }
        const {text, images} = buildMessage(draft);
        onSend(text, images);
        clearDraft();
    };

    // 명령을 그대로 실행 (인자 없이)
    const runCommand = (cmd: MenuCommand) => {
        setCommandsOpen(false);
        if (checkingCommand || handleSlash(cmd.name)) return;
        if (isLoading) {
            queueDraft({...EMPTY_DRAFT, input: cmd.name});
            return;
        }
        onSend(cmd.name, []);
        clearDraft();
    };

    // 메뉴에서 고른 명령: 스킬·사용자·플러그인 명령은 늘, 내장 명령은 인자 자리(argumentHint)가 있으면 "/이름 "까지만
    // 채우고 인자를 기다린다 — 스킬은 argumentHint가 없어도 인자를 받는 일이 많아서, 고르자마자 보내면 인자를 붙일 틈이
    // 없었다. 터미널 전용 명령은 채울 것 없이 바로 알린다.
    const pickCommand = (cmd: MenuCommand) => {
        if (cmd.where !== "terminal" && (cmd.source === "custom" || cmd.argumentHint)) fillCommand(cmd);
        else runCommand(cmd);
    };

    // 응답이 끝나면 대기 메시지를 보낸다. 중지로 끝났으면 보내지 않고 입력창으로 되돌린다
    // (멈춘 이유가 그 메시지와 상관있을 수 있다). "지금 보내기"는 중지한 뒤 바로 보낸다.
    useEffect(() => {
        if (turnEnd.seq === seenTurnEndRef.current) return;
        seenTurnEndRef.current = turnEnd.seq;
        const sendNow = sendAfterStopRef.current;
        sendAfterStopRef.current = false;
        if (!queued) return;
        setQueued(null);
        // 중지했거나 오류로 끝났으면 보내지 않고 입력창으로 되돌린다 — 사용량 한도 같은 오류면 보내도 같은 오류가 난다.
        // ("지금 보내기"는 일부러 멈추고 보내는 것이라 그대로 보낸다)
        if ((turnEnd.stopped || turnEnd.failed) && !sendNow) {
            restoreDraft(queued);
            return;
        }
        const {text, images} = buildMessage(queued);
        onSend(text, images);
    }, [turnEnd, queued, onSend, restoreDraft]);

    // 새 대화·다른 대화로 옮기면 대기 메시지를 그 대화로 보내지 않는다 — 입력창으로 되돌린다
    useEffect(() => {
        if (resetSignal === seenResetRef.current) return;
        seenResetRef.current = resetSignal;
        sendAfterStopRef.current = false;
        if (!queued) return;
        setQueued(null);
        restoreDraft(queued);
    }, [resetSignal, queued, restoreDraft]);

    const sendQueuedNow = () => {
        sendAfterStopRef.current = true;
        onStop();
    };

    const editQueued = () => {
        if (!queued) return;
        setQueued(null);
        restoreDraft(queued);
    };

    const fillCommand = (cmd: MenuCommand) => {
        setInput(cmd.name + " ");
        setCommandsOpen(false);
        textareaRef.current?.focus();
    };

    // 다음 요청 추천은 아무것도 안 쓴 입력창에서만 보인다 (첨부만 있어도 숨긴다)
    const showSuggestion =
        suggestOn && !!suggestion && !isLoading && input === "" && selectedImages.length === 0 && selectedFiles.length === 0;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // 조합이 끝난 뒤 오는 진짜 키 입력에서 처리한다
        if (isImeComposing(e)) return;
        // 흐리게 보이는 다음 요청 추천을 채운다 (보내지는 않는다 — 고쳐서 보낼 수 있게)
        if (e.key === "Tab" && !e.shiftKey && showSuggestion && suggestion) {
            e.preventDefault();
            setInput(suggestion);
            // 직접 친 글이 아니라 handleInput이 돌지 않는다 — 높이를 따로 맞춘다(긴 추천이 한 줄 칸에 갇혔다)
            scheduleResize();
            onSuggestionUsed?.();
            return;
        }
        if (mentionOpen && mentionFiles.length > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveMention((i) => (i + 1) % mentionFiles.length);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveMention((i) => (i - 1 + mentionFiles.length) % mentionFiles.length);
                return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                addMention(mentionFiles[activeMention]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setMentionOpen(false);
                return;
            }
        }
        if (commandsOpen && filteredCommands.length > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveCommand((i) => (i + 1) % filteredCommands.length);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveCommand((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
                return;
            }
            if (e.key === "Tab") {
                e.preventDefault();
                fillCommand(filteredCommands[activeCommand]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setCommandsOpen(false);
                return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // 내장 명령의 이름을 다 쳤으면 그대로 실행. 이름 일부만 쳤거나 스킬·사용자 명령이면 이름만 채운다 —
                // 실행은 입력창에 보이는 그대로 한 번 더 Enter. 예전에는 이름 일부에서 Enter를 누르면 맨 위 명령이 바로
                // 돌아서 "/us"가 /usage-credits(브라우저가 열린다), "/ul"이 /ultrareview(클라우드 리뷰)가 될 수 있었다.
                const cmd = filteredCommands[activeCommand];
                if (cmd.source !== "custom" && cmd.name.toLowerCase() === input.trim().toLowerCase()) runCommand(cmd);
                else fillCommand(cmd);
                return;
            }
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setInput(value);
        // /로 시작하고 첫 토큰만 입력된 상태일 때 드롭다운 표시.
        // 공백/줄바꿈이 들어오면 인자 입력 단계로 보고 닫는다.
        const shouldOpen = value.startsWith("/") && !/[\s]/.test(value);
        setCommandsOpen(shouldOpen);
        // @ 멘션: 커서 앞 토큰을 보고 작업 디렉토리 파일을 검색
        const cursor = e.target.selectionStart ?? value.length;
        const mention = shouldOpen ? null : detectMention(value, cursor);
        if (mention) {
            mentionStartRef.current = mention.start;
            setMentionOpen(true);
            setActiveMention(0);
            void window.electronAPI.searchFiles(tabId, mention.query).then(setMentionFiles);
        } else {
            setMentionOpen(false);
            setMentionFiles([]);
        }
        scheduleResize();
    };

    const addFiles = useCallback(async (files: File[]) => {
        if (files.length === 0) return;
        const images = files.filter((f) => f.type.startsWith("image/"));
        const others = files.filter((f) => !f.type.startsWith("image/"));
        if (images.length > 0) {
            const payloads = await Promise.all(images.map(readFileAsImagePayload));
            setSelectedImages((prev) => [...prev, ...payloads]);
        }
        if (others.length > 0) {
            setSelectedFiles((prev) => [
                ...prev,
                ...others.map((f) => ({name: f.name, path: window.electronAPI.getPathForFile(f)})),
            ]);
        }
    }, []);

    const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((f): f is File => f !== null);
        if (files.length === 0) return;
        e.preventDefault();
        await addFiles(files);
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        await addFiles(files);
    };

    // 탭 화면 전체에 끌어다 놓은 파일을 받는다 (ChatTabView가 드래그를 맡는다 — 예전에는 입력창 위에 놓아야만 붙었다)
    useEffect(() => {
        if (!onRegisterAddFiles) return;
        onRegisterAddFiles((files) => void addFiles(files));
        return () => onRegisterAddFiles(null);
    }, [onRegisterAddFiles, addFiles]);

    useEffect(() => {
        if (!onRegisterAddMention) return;
        onRegisterAddMention((p) => {
            setMentionedFiles((prev) => (prev.includes(p) ? prev : [...prev, p]));
            textareaRef.current?.focus();
        });
        return () => onRegisterAddMention(null);
    }, [onRegisterAddMention]);

    // 바깥(화면 대조)에서 글·그림 넣기 — 쓰던 글이 있으면 그 뒤에 잇는다(아무것도 버리지 않는다)
    useEffect(() => {
        if (!onRegisterFill) return;
        onRegisterFill((text, images) => {
            setInput((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text));
            if (images.length > 0) setSelectedImages((cur) => [...cur, ...images]);
            // 높이는 바뀐 글이 그려진 뒤에 잰다 (아래 input 효과)
            resizeAfterFillRef.current = true;
            textareaRef.current?.focus();
        });
        return () => onRegisterFill(null);
    }, [onRegisterFill, scheduleResize]);

    const removeImage = (index: number) => {
        setSelectedImages((prev) => prev.filter((_, i) => i !== index));
    };

    const removeFile = (index: number) => {
        setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleAddPrompt = async () => {
        const trimmed = newPromptInput.trim();
        if (!trimmed) return;
        if (promptHooks && !promptHooks.confirm()) return;
        const updated = await window.electronAPI.addPrompt(trimmed);
        setPrompts(updated);
        setNewPromptInput("");
        promptHooks?.changed();
    };

    const handleRemovePrompt = async (index: number) => {
        if (promptHooks && !promptHooks.confirm()) return;
        const updated = await window.electronAPI.removePrompt(index);
        setPrompts(updated);
        promptHooks?.changed();
    };

    const canSend =
        input.trim().length > 0 ||
        selectedImages.length > 0 ||
        selectedFiles.length > 0 ||
        mentionedFiles.length > 0;

    return (
        <div className={cx("inputArea")}>
            {top}
            {attachedLightbox}
            {promptInputOpen && (
                <div className={cx("promptArea")}>
                    {prompts.length > 0 && (
                        <div className={cx("promptPills")}>
                            {prompts.map((p, i) => (
                                <div key={i} className={cx("promptPill")}>
                                    {/* 칩은 한 줄로 잘리므로 전체 내용은 툴팁으로 보여준다 */}
                                    <span className={cx("promptPillText")} title={p}>{p}</span>
                                    <button
                                        className={cx("promptPillRemove")}
                                        onClick={() => handleRemovePrompt(i)}
                                        title="이 프롬프트 삭제"
                                    >
                                        <FontAwesomeIcon icon={faXmark} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className={cx("promptInputRow")}>
                        <input
                            autoFocus
                            className={cx("promptInput")}
                            placeholder="시스템 프롬프트 입력..."
                            value={newPromptInput}
                            onChange={(e) => setNewPromptInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (isImeComposing(e)) return;
                                if (e.key === "Enter") {
                                    handleAddPrompt();
                                    setPromptInputOpen(false);
                                }
                                if (e.key === "Escape") {
                                    setNewPromptInput("");
                                    setPromptInputOpen(false);
                                }
                            }}
                        />
                        {/* 마우스를 올리거나 탭으로 포커스하면 안내문이 뜬다 */}
                        <div className={cx("promptInfo")} tabIndex={0} aria-describedby="prompt-info-tip">
                            <FontAwesomeIcon icon={faCircleInfo} />
                            <div id="prompt-info-tip" role="tooltip" className={cx("promptInfoTip")}>
                                <strong className={cx("promptInfoTitle")}>시스템 프롬프트 안내</strong>
                                <ul className={cx("promptInfoList")}>
                                    <li>추가·삭제는 다음 메시지부터 모든 대화에 적용됩니다.</li>
                                    <li>대화 도중에 바꾸면 Claude가 그 대화의 이전 사고 내용을 이어받지 못할 수 있습니다.</li>
                                    <li>백그라운드 작업이 실행 중일 때 바꾸면, 다음 메시지를 보낼 때 그 작업이 종료됩니다.</li>
                                </ul>
                            </div>
                        </div>
                        <button
                            className={cx("promptAddBtn")}
                            onClick={() => {
                                handleAddPrompt();
                                setPromptInputOpen(false);
                            }}
                            disabled={!newPromptInput.trim()}
                        >
                            <FontAwesomeIcon icon={faPlus} />
                        </button>
                    </div>
                </div>
            )}

            {(selectedImages.length > 0 || selectedFiles.length > 0) && (
                <div className={cx("imagePreviewStrip")} ref={attachStripRef}>
                    {selectedImages.map((img, i) =>
                        img.caption ? (
                            // 이름·설명이 붙은 그림(화면 대조가 넣은 것) — 파일 카드처럼 작은 그림 + 이름 + 설명
                            <div key={`img-${i}`} className={cx("filePreviewItem", "imagePreviewCard")} data-tooltip={img.name}>
                                <img
                                    src={img.previewUrl}
                                    className={cx("imagePreviewCardThumb")}
                                    alt=""
                                    draggable={false}
                                    data-zoomable=""
                                    data-zoom-name={img.name ?? "첨부한 그림"}
                                    onClick={(e) => openAttached(img.previewUrl, e.currentTarget)}
                                />
                                <span className={cx("attachCardText")}>
                                    <span className={cx("attachCardName")}>
                                        <MiddleName name={img.name ?? "그림"} />
                                    </span>
                                    <span className={cx("attachCardSub")}>{img.caption}</span>
                                </span>
                                <button className={cx("imagePreviewRemove")} onClick={() => removeImage(i)} aria-label="첨부 빼기">
                                    <FontAwesomeIcon icon={faXmark} />
                                </button>
                            </div>
                        ) : (
                            <div key={`img-${i}`} className={cx("imagePreviewItem")}>
                                {/* 보내기 전에도 눌러서 크게 (첨부한 그림끼리 앞뒤로 넘긴다) */}
                                <img
                                    src={img.previewUrl}
                                    className={cx("imagePreviewThumb")}
                                    alt=""
                                    draggable={false}
                                    data-zoomable=""
                                    data-zoom-name={img.name ?? "첨부한 그림"}
                                    onClick={(e) => openAttached(img.previewUrl, e.currentTarget)}
                                    data-tooltip="눌러서 크게 보기"
                                />
                                <button className={cx("imagePreviewRemove")} onClick={() => removeImage(i)}>
                                    <FontAwesomeIcon icon={faXmark} />
                                </button>
                            </div>
                        )
                    )}
                    {/* 첨부 파일 — 보낸 메시지의 파일 카드와 같은 모양 (종류별 색 아이콘 + 이름 + 폴더) */}
                    {selectedFiles.map((f, i) => {
                        const fi = iconForFile(f.name);
                        const slash = f.path.lastIndexOf("/");
                        return (
                            <div key={`file-${i}`} className={cx("filePreviewItem")} data-tooltip={f.path ? tildePath(f.path) : f.name}>
                                <span className={cx("attachCardIcon")} style={iconVars(fi)}>
                                    <FontAwesomeIcon icon={fi.icon} />
                                </span>
                                <span className={cx("attachCardText")}>
                                    <span className={cx("attachCardName")}>
                                        <MiddleName name={f.name} />
                                    </span>
                                    <span className={cx("attachCardSub")}>
                                        <MiddleName name={slash > 0 ? tildePath(f.path.slice(0, slash)) : "경로를 알 수 없음"} />
                                    </span>
                                </span>
                                <button className={cx("imagePreviewRemove")} onClick={() => removeFile(i)} aria-label="첨부 빼기">
                                    <FontAwesomeIcon icon={faXmark} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
            {mentionedFiles.length > 0 && (
                <div className={cx("mentionChipStrip")}>
                    {mentionedFiles.map((f) => {
                        const fi = iconForFile(f);
                        return (
                            <div key={f} className={cx("mentionChip")} title={f}>
                                <FontAwesomeIcon
                                    icon={fi.icon}
                                    className={cx("mentionChipIcon")}
                                    style={iconStyle(fi)}
                                />
                                <span className={cx("mentionChipName")}>{fileBase(f)}</span>
                                <button
                                    className={cx("mentionChipRemove")}
                                    onClick={() => removeMention(f)}
                                    aria-label="제거"
                                >
                                    <FontAwesomeIcon icon={faXmark} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
            {mentionOpen && mentionFiles.length > 0 && (
                <div className={cx("mentionDropdown")}>
                    {mentionFiles.map((f, i) => {
                        const fi = iconForFile(f);
                        const dir = fileDir(f);
                        return (
                            <div
                                key={f}
                                ref={i === activeMention ? activeMentionRef : undefined}
                                className={cx("mentionItem", {mentionItemActive: i === activeMention})}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    addMention(f);
                                }}
                                onMouseEnter={() => setActiveMention(i)}
                            >
                                <FontAwesomeIcon
                                    icon={fi.icon}
                                    className={cx("mentionIcon")}
                                    style={iconStyle(fi)}
                                />
                                <span className={cx("mentionName")}>{fileBase(f)}</span>
                                {dir && (
                                    <span className={cx("mentionPath")}>
                                        <FontAwesomeIcon icon={faFolder} className={cx("mentionPathIcon")} />
                                        <span className={cx("mentionPathText")}>{dir}</span>
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {commandsOpen && filteredCommands.length > 0 && (
                <div className={cx("commandsDropdown")}>
                    {filteredCommands.map((cmd, i) => (
                        <div
                            key={cmd.source + cmd.name}
                            className={cx("commandItem", {commandItemActive: i === activeCommand})}
                            onMouseDown={(e) => {
                                // textarea blur 방지
                                e.preventDefault();
                                pickCommand(cmd);
                            }}
                            onMouseEnter={() => setActiveCommand(i)}
                        >
                            <div className={cx("commandRow")}>
                                <span className={cx("commandName")}>
                                    {cmd.name}
                                    {cmd.argumentHint && <span className={cx("commandHint")}> {cmd.argumentHint}</span>}
                                </span>
                                {/* 앱 = CLI로 보내지 않고 앱이 한다, 터미널 = 터미널의 claude에서만 된다 */}
                                {cmd.where && (
                                    <span className={cx("commandWhere", cmd.where === "app" ? "commandWhereApp" : "commandWhereTerminal")}>
                                        {cmd.where === "app" ? "앱" : "터미널"}
                                    </span>
                                )}
                                <span className={cx("commandSource")}>{cmd.source === "builtin" ? "내장" : "사용자"}</span>
                            </div>
                            {(cmd.note ?? cmd.description) && (
                                <span className={cx("commandDesc")}>{cmd.note ?? cmd.description}</span>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {checkingCommand && (
                <div className={cx("commandChecking")} role="status">
                    명령 목록을 다시 확인하는 중…
                </div>
            )}
            {queued && (
                <div className={cx("queuedBar")}>
                    <FontAwesomeIcon icon={faClock} className={cx("queuedIcon")} />
                    <span className={cx("queuedLabel")}>응답이 끝나면 보냄</span>
                    <span className={cx("queuedText")} title={buildMessage(queued).text}>
                        {draftPreview(queued)}
                    </span>
                    <button
                        className={cx("queuedBtn", "queuedBtnPrimary")}
                        onClick={sendQueuedNow}
                        title="지금 응답을 멈추고 바로 보냅니다"
                    >
                        지금 보내기
                    </button>
                    <button className={cx("queuedBtn")} onClick={editQueued} title="보내지 않고 입력창으로 되돌립니다">
                        수정
                    </button>
                </div>
            )}
            <div className={cx("inputRow")}>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={handleFileSelect}
                />
                <button
                    className={cx("imageButton")}
                    onClick={() => fileInputRef.current?.click()}
                    data-tooltip="파일 첨부"
                >
                    <FontAwesomeIcon icon={faPaperclip} />
                </button>
                <button
                    className={cx("imageButton", {promptBtnActive: promptInputOpen || prompts.length > 0})}
                    onClick={() => setPromptInputOpen((v) => !v)}
                    data-tooltip="시스템 프롬프트"
                >
                    <FontAwesomeIcon icon={faTerminal} />
                    {prompts.length > 0 && !promptInputOpen && (
                        <span className={cx("promptBtnBadge")}>{prompts.length}</span>
                    )}
                </button>
                <div className={cx("textareaWrap")}>
                    <textarea
                        data-chat-input
                        ref={textareaRef}
                        className={cx("textarea", {textareaSuggest: showSuggestion})}
                        placeholder={
                            showSuggestion
                                ? suggestion
                                : isLoading
                                  ? "응답 중에도 미리 써 둘 수 있어요 — Enter를 누르면 끝나는 대로 보냅니다"
                                  : "메시지를 입력하세요... (Shift+Enter로 줄바꿈)"
                        }
                        value={input}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onBlur={() => window.setTimeout(() => setMentionOpen(false), 120)}
                        rows={1}
                    />
                    {/* 추천은 안내문(투명, 읽기 프로그램용) 대신 이 층이 그린다 — 크롬은 textarea 안내문에 …을 그리지
                        않아 긴 추천이 말없이 잘리고 Tab 안내까지 가려졌다 */}
                    {showSuggestion && (
                        <div className={cx("suggestGhost")} aria-hidden>
                            <span className={cx("suggestText")}>{suggestion}</span>
                            <kbd className={cx("suggestKey")}>Tab</kbd>
                        </div>
                    )}
                </div>
                {isLoading ? (
                    <>
                        {canSend && (
                            <button
                                className={cx("sendButton")}
                                onClick={handleSend}
                                data-tooltip="응답이 끝나면 보내기"
                                aria-label="응답이 끝나면 보내기"
                            >
                                <FontAwesomeIcon icon={faClock} />
                            </button>
                        )}
                        <button className={cx("stopButton")} onClick={onStop} data-tooltip="중지">
                            <FontAwesomeIcon icon={faStop} />
                        </button>
                    </>
                ) : (
                    <button
                        className={cx("sendButton")}
                        onClick={handleSend}
                        disabled={!canSend}
                        data-tooltip="전송"
                    >
                        <FontAwesomeIcon icon={faPaperPlane} />
                    </button>
                )}
            </div>
        </div>
    );
}
