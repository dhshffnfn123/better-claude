import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
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
import type {ImagePayload} from "../../hooks/useClaudeChat";
import {readFileAsImagePayload} from "../../hooks/useClaudeChat";

const cx = classNames.bind(styles);

// 커서 바로 앞에 입력 중인 @토큰을 찾는다. 공백/줄바꿈/다른 @가 나오면 멘션이 아니다.
function detectMention(text: string, cursor: number): {query: string; start: number} | null {
    const upto = text.slice(0, cursor);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    const query = m[1];
    return {query, start: cursor - query.length - 1};
}

const fileBase = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const fileDir = (p: string) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
};

// 확장자별 아이콘 + 색상. 없으면 기본 파일 아이콘.
const FILE_ICONS: Record<string, {icon: IconDefinition; color: string}> = {
    ts: {icon: faFileCode, color: "#3178c6"},
    tsx: {icon: faReact, color: "#61dafb"},
    js: {icon: faJs, color: "#f7df1e"},
    jsx: {icon: faReact, color: "#61dafb"},
    mjs: {icon: faJs, color: "#f7df1e"},
    cjs: {icon: faJs, color: "#f7df1e"},
    json: {icon: faFileCode, color: "#cbab38"},
    scss: {icon: faSass, color: "#cd6799"},
    sass: {icon: faSass, color: "#cd6799"},
    css: {icon: faCss3Alt, color: "#2965f1"},
    html: {icon: faHtml5, color: "#e34f26"},
    md: {icon: faMarkdown, color: "#3a3d35"},
    markdown: {icon: faMarkdown, color: "#3a3d35"},
    py: {icon: faPython, color: "#3776ab"},
    rs: {icon: faRust, color: "#b7410e"},
    png: {icon: faFileImage, color: "#7e8c6a"},
    jpg: {icon: faFileImage, color: "#7e8c6a"},
    jpeg: {icon: faFileImage, color: "#7e8c6a"},
    gif: {icon: faFileImage, color: "#7e8c6a"},
    webp: {icon: faFileImage, color: "#7e8c6a"},
    svg: {icon: faFileImage, color: "#7e8c6a"},
    pdf: {icon: faFilePdf, color: "#e5252a"},
    csv: {icon: faFileCsv, color: "#1d6f42"},
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
    sh: {icon: faTerminal, color: "#3a3d35"},
    bash: {icon: faTerminal, color: "#3a3d35"},
    zsh: {icon: faTerminal, color: "#3a3d35"},
    lock: {icon: faLock, color: "#a8a99a"},
};

const DEFAULT_FILE_ICON: {icon: IconDefinition; color: string} = {icon: faFile, color: "#c9a84c"};

function iconForFile(p: string): {icon: IconDefinition; color: string} {
    const base = fileBase(p);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    return FILE_ICONS[ext] ?? DEFAULT_FILE_ICON;
}

interface Props {
    isLoading: boolean;
    onSend: (message: string, images: ImagePayload[]) => void;
    onStop: () => void;
}

export function ChatInput({isLoading, onSend, onStop}: Props) {
    const [input, setInput] = useState("");
    const [selectedImages, setSelectedImages] = useState<ImagePayload[]>([]);
    const [selectedFiles, setSelectedFiles] = useState<{name: string; path: string}[]>([]);
    const [prompts, setPrompts] = useState<string[]>([]);
    const [promptInputOpen, setPromptInputOpen] = useState(false);
    const [newPromptInput, setNewPromptInput] = useState("");
    const [commands, setCommands] = useState<SlashCommand[]>([]);
    const [commandsOpen, setCommandsOpen] = useState(false);
    const [activeCommand, setActiveCommand] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionFiles, setMentionFiles] = useState<string[]>([]);
    const [activeMention, setActiveMention] = useState(0);
    const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const resizeFrameRef = useRef<number | null>(null);
    const dragCounterRef = useRef(0);
    const mentionStartRef = useRef(-1);
    const pendingCursorRef = useRef<number | null>(null);
    const activeMentionRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        window.electronAPI.getPrompts().then(setPrompts);
        window.electronAPI.listCommands().then(setCommands);
        // 작업 폴더가 바뀌거나 CLI가 새 스킬을 찾으면 목록이 다시 온다
        return window.electronAPI.onCommands(setCommands);
    }, []);

    const filteredCommands = useMemo(() => {
        if (!commandsOpen) return [];
        const q = input.toLowerCase();
        return commands.filter((c) => c.name.toLowerCase().startsWith(q));
    }, [commands, input, commandsOpen]);

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

    const handleSend = () => {
        const trimmed = input.trim();
        if (
            (!trimmed &&
                selectedImages.length === 0 &&
                selectedFiles.length === 0 &&
                mentionedFiles.length === 0) ||
            isLoading
        )
            return;
        const parts: string[] = [];
        if (selectedFiles.length > 0) {
            const withPath = selectedFiles.filter((f) => f.path);
            const withoutPath = selectedFiles.filter((f) => !f.path);
            if (withPath.length > 0) {
                parts.push(
                    "첨부 파일 — 아래 경로의 파일을 Read 도구로 읽어주세요:\n" +
                        withPath.map((f) => `- ${f.path}`).join("\n")
                );
            }
            if (withoutPath.length > 0) {
                parts.push(`[첨부(경로를 확인할 수 없어 읽을 수 없음): ${withoutPath.map((f) => f.name).join(", ")}]`);
            }
        }
        if (mentionedFiles.length > 0) {
            parts.push(
                "참조 파일 — 아래 경로를 Read 도구로 읽어주세요:\n" +
                    mentionedFiles.map((p) => `- ${p}`).join("\n")
            );
        }
        if (trimmed) parts.push(trimmed);
        onSend(parts.join("\n\n"), selectedImages);
        setInput("");
        setSelectedImages([]);
        setSelectedFiles([]);
        setMentionedFiles([]);
        setMentionOpen(false);
        resetTextareaHeight();
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const sendCommand = (cmd: SlashCommand) => {
        if (isLoading) return;
        onSend(cmd.name, []);
        setInput("");
        setSelectedImages([]);
        setSelectedFiles([]);
        setMentionedFiles([]);
        setMentionOpen(false);
        resetTextareaHeight();
        setCommandsOpen(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const fillCommand = (cmd: SlashCommand) => {
        setInput(cmd.name + " ");
        setCommandsOpen(false);
        textareaRef.current?.focus();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
                sendCommand(filteredCommands[activeCommand]);
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
            void window.electronAPI.searchFiles(mention.query).then(setMentionFiles);
        } else {
            setMentionOpen(false);
            setMentionFiles([]);
        }
        // scrollHeight 읽기는 강제 reflow를 유발하므로 rAF로 디퍼
        if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.style.height = "44px";
            el.style.height = `${el.scrollHeight}px`;
            resizeFrameRef.current = null;
        });
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

    const hasDraggedFiles = (e: React.DragEvent) =>
        Array.from(e.dataTransfer.types).includes("Files");

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragCounterRef.current += 1;
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragging(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragCounterRef.current = 0;
        setIsDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
    };

    const removeImage = (index: number) => {
        setSelectedImages((prev) => prev.filter((_, i) => i !== index));
    };

    const removeFile = (index: number) => {
        setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleAddPrompt = async () => {
        const trimmed = newPromptInput.trim();
        if (!trimmed) return;
        const updated = await window.electronAPI.addPrompt(trimmed);
        setPrompts(updated);
        setNewPromptInput("");
    };

    const handleRemovePrompt = async (index: number) => {
        const updated = await window.electronAPI.removePrompt(index);
        setPrompts(updated);
    };

    const canSend =
        input.trim().length > 0 ||
        selectedImages.length > 0 ||
        selectedFiles.length > 0 ||
        mentionedFiles.length > 0;

    return (
        <div
            className={cx("inputArea", {inputAreaDragging: isDragging})}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {isDragging && (
                <div className={cx("dragOverlay")}>
                    <FontAwesomeIcon icon={faPaperclip} />
                    <span>여기에 파일을 놓으세요</span>
                </div>
            )}
            {promptInputOpen && (
                <div className={cx("promptArea")}>
                    {prompts.length > 0 && (
                        <div className={cx("promptPills")}>
                            {prompts.map((p, i) => (
                                <div key={i} className={cx("promptPill")}>
                                    <span className={cx("promptPillText")}>{p}</span>
                                    <button
                                        className={cx("promptPillRemove")}
                                        onClick={() => handleRemovePrompt(i)}
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
                <div className={cx("imagePreviewStrip")}>
                    {selectedImages.map((img, i) => (
                        <div key={`img-${i}`} className={cx("imagePreviewItem")}>
                            <img src={img.previewUrl} className={cx("imagePreviewThumb")} alt="" />
                            <button className={cx("imagePreviewRemove")} onClick={() => removeImage(i)}>
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>
                    ))}
                    {selectedFiles.map((f, i) => (
                        <div key={`file-${i}`} className={cx("filePreviewItem")} title={f.name}>
                            <FontAwesomeIcon icon={faPaperclip} className={cx("filePreviewIcon")} />
                            <span className={cx("filePreviewName")}>{f.name}</span>
                            <button className={cx("imagePreviewRemove")} onClick={() => removeFile(i)}>
                                <FontAwesomeIcon icon={faXmark} />
                            </button>
                        </div>
                    ))}
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
                                    style={{color: fi.color}}
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
                                    style={{color: fi.color}}
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
                                sendCommand(cmd);
                            }}
                            onMouseEnter={() => setActiveCommand(i)}
                        >
                            <div className={cx("commandRow")}>
                                <span className={cx("commandName")}>
                                    {cmd.name}
                                    {cmd.argumentHint && <span className={cx("commandHint")}> {cmd.argumentHint}</span>}
                                </span>
                                <span className={cx("commandSource")}>{cmd.source === "builtin" ? "내장" : "사용자"}</span>
                            </div>
                            {cmd.description && (
                                <span className={cx("commandDesc")}>{cmd.description}</span>
                            )}
                        </div>
                    ))}
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
                    disabled={isLoading}
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
                <textarea
                    ref={textareaRef}
                    className={cx("textarea")}
                    placeholder="메시지를 입력하세요... (Shift+Enter로 줄바꿈)"
                    value={input}
                    onChange={handleInput}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onBlur={() => window.setTimeout(() => setMentionOpen(false), 120)}
                    rows={1}
                    disabled={isLoading}
                />
                {isLoading ? (
                    <button className={cx("stopButton")} onClick={onStop} data-tooltip="중지">
                        <FontAwesomeIcon icon={faStop} />
                    </button>
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
