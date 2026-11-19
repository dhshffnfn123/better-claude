import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowLeft,
    faArrowsRotate,
    faBook,
    faCheck,
    faCircleInfo,
    faCircleNotch,
    faCopy,
    faEye,
    faFileLines,
    faFloppyDisk,
    faFolderOpen,
    faHandPointer,
    faMagnifyingGlass,
    faPen,
    faPlus,
    faRotateLeft,
    faTriangleExclamation,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import shared from "../chat.page.module.scss";
import styles from "./SkillsTab.module.scss";
import type {ExtensionsTabProps} from "../../../extensions-open";
import {MiddleName} from "../MiddleName";
import {Markdown} from "../MessageItem";
import {ImageViewer} from "../Lightbox";
import {isImeComposing} from "../ChatInput";
import {TabIdContext} from "../../../tab-context";
import {copyText} from "../../../clipboard";
import {compactTokens} from "../../../token-format";
import {tildePath} from "../../../attachments";

const cx = classNames.bind(styles);
const sx = classNames.bind(shared);

// 스킬 탭 — 소유자의 그림: 스킬 = 서랍 속 매뉴얼. 이름과 설명만 늘 Claude에게 보이고(그 토큰), 본문은 쓸 때 읽는다.
// /이름으로 직접 부를 수 있고, "직접 부를 때만"(disable-model-invocation)이면 Claude가 스스로 꺼내 쓰지 않는다.
// 목록·읽기·저장·만들기는 main(skills:*)이 하고 경로도 main이 검사한다 — main/services/skills.ts.
// 창은 탭을 옮기거나 새로 열 때마다 이 본문을 새로 그린다 — 목록·고치던 글은 모듈에 둔다.

// 마지막 목록 (탭 + 폴더마다) — 다시 열면 먼저 보여 주고 새로 받는다
const listCache = new Map<string, Extract<SkillsList, {ok: true}>>();
// 저장하지 않은 고침 — 창을 닫거나 다른 탭을 봐도 남는다. 경로마다 하나 (지침 패널과 같은 방식)
const drafts = new Map<string, {text: string; base: number | null}>();
// 마지막으로 연 스킬 (탭 + 폴더마다)
const lastPick = new Map<string, string>();

type ListOk = Extract<SkillsList, {ok: true}>;

interface Group {
    key: string;
    title: string;
    hint: string;
    full?: string; // 그 무리의 폴더 전체 경로 (설명 줄에 마우스를 올리면)
    items: SkillEntry[];
}

function groupsOf(skills: SkillEntry[], project: SkillProjectTarget, personalDir: string): Group[] {
    const g = new Map<string, Group>();
    const add = (key: string, title: string, hint: string, e: SkillEntry, full?: string) => {
        let x = g.get(key);
        if (!x) {
            x = {key, title, hint, full, items: []};
            g.set(key, x);
        }
        x.items.push(e);
    };
    // 경로는 짧게 — 폴더 이름만 (전체는 줄에 마우스를 올리면)
    const projectHint = `${project.ok ? `${project.base.split("/").pop()}/` : ""}.claude/skills · git으로 함께 씁니다`;
    const personal = tildePath(personalDir);
    const personalHint = `${personal === "~/.claude/skills" ? personal : "설정 폴더(CLAUDE_CONFIG_DIR)/skills"} · 어느 폴더에서 대화하든 씁니다`;
    for (const e of skills) {
        if (e.legacy && (e.scope === "personal" || e.scope === "project")) {
            add("legacy", "옛 명령", ".claude/commands의 .md — 예전 방식이지만 그대로 작동합니다", e);
        } else if (e.scope === "personal") {
            add("personal", "개인", personalHint, e, personalDir);
        } else if (e.scope === "project") {
            add("project", "이 프로젝트", projectHint, e, project.ok ? project.dir : undefined);
        } else if (e.scope === "plugin") {
            const name = e.plugin ?? "플러그인";
            add(`plugin:${name}`, `플러그인 · ${name}`, "플러그인이 넣은 스킬 — 플러그인을 업데이트하면 바뀌어서 읽기만 합니다", e);
        } else if (e.scope === "managed") {
            add("managed", "관리자", "회사·관리자가 넣은 스킬 — 읽기만 합니다", e);
        } else if (e.scope === "synced") {
            add("synced", "claude.ai", "claude.ai에서 켠 스킬", e);
        } else if (e.scope === "builtin") {
            add("builtin", "기본 제공", "Claude Code에 들어 있는 스킬", e);
        } else {
            add("other", "그 밖", "CLI가 알려 준 스킬", e);
        }
    }
    const order = (k: string) =>
        k === "personal" ? 0 : k === "project" ? 1 : k.startsWith("plugin:") ? 2 : k === "legacy" ? 3 : k === "managed" ? 4 : k === "synced" ? 5 : k === "other" ? 6 : 7;
    const list = [...g.values()].sort((a, b) => order(a.key) - order(b.key) || a.title.localeCompare(b.title));
    for (const x of list) x.items.sort((a, b) => a.name.localeCompare(b.name));
    return list;
}

function groupTokens(items: SkillEntry[]): number | null {
    if (items.some((e) => e.tokens === null)) return null;
    return items.reduce((n, e) => n + (e.tokens ?? 0), 0);
}

function matches(e: SkillEntry, q: string): boolean {
    if (!q) return true;
    const t = q.toLowerCase();
    return e.name.toLowerCase().includes(t) || e.description.toLowerCase().includes(t) || (e.plugin ?? "").toLowerCase().includes(t);
}

function stripFrontmatter(text: string): string {
    const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return m ? text.slice(m[0].length) : text;
}

function dirOf(p: string): string {
    return p.slice(0, p.lastIndexOf("/"));
}

function scopeLabel(e: SkillEntry): string {
    if (e.legacy) return e.scope === "personal" ? "개인 · 옛 명령" : e.scope === "project" ? "프로젝트 · 옛 명령" : "옛 명령";
    switch (e.scope) {
        case "personal":
            return "개인";
        case "project":
            return "프로젝트";
        case "plugin":
            return e.plugin ? `플러그인 ${e.plugin}` : "플러그인";
        case "managed":
            return "관리자";
        case "builtin":
            return "기본 제공";
        case "synced":
            return "claude.ai";
        default:
            return "기타";
    }
}

function sizeLabel(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (n >= 1024) return `${Math.round(n / 1024)}KB`;
    return `${n}B`;
}

// 프로젝트 스킬이 작업 폴더가 아닌 곳(위 폴더, 원래 저장소)에서 왔으면 어디인지
function whereLabel(e: SkillEntry, cwd: string): string | null {
    if (e.scope !== "project" || !e.base) return null;
    if (e.base === cwd) return null;
    if (cwd.startsWith(e.base + "/")) return `${tildePath(e.base).split("/").pop()} (위 폴더)`;
    return tildePath(e.base);
}

export function SkillsTab({tabId, cwd, focus}: ExtensionsTabProps) {
    const key = `${tabId}\u0000${cwd}`;
    const [list, setList] = useState<SkillsList | null>(() => listCache.get(key) ?? null);
    // 처음부터 "받는 중" — 마운트하자마자 새 목록을 받는다. 찾아갈 스킬(focus)이 모아 둔 목록에 없으면 새 목록까지 기다린다.
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<string | null>(() => (focus ? null : lastPick.get(key) ?? null));
    const [creating, setCreating] = useState(false);
    const [focusMiss, setFocusMiss] = useState<string | null>(null);
    const seqRef = useRef(0);
    const focusDone = useRef(false);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    const searchRef = useRef<HTMLInputElement>(null);

    const load = useCallback(
        async (refresh = false) => {
            const seq = ++seqRef.current;
            setLoading(true);
            const r: SkillsList = await window.electronAPI
                .listSkills(tabId, refresh)
                .catch((e: unknown) => ({ok: false as const, error: String(e)}));
            if (seq !== seqRef.current) return;
            if (r.ok === true) listCache.set(key, r);
            setList((prev) => (r.ok === false && prev?.ok === true ? prev : r));
            setLoading(false);
        },
        [tabId, key]
    );

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (selected) lastPick.set(key, selected);
    }, [selected, key]);

    const data: ListOk | null = list?.ok === true ? list : null;

    // 찾아갈 스킬 (답변의 스킬 줄·내 메시지의 /이름에서 "보기") — 목록이 오면 한 번 고르고 그 줄로 스크롤
    useEffect(() => {
        if (!focus || focusDone.current || !data) return;
        const want = focus.replace(/^\//, "");
        const hit =
            data.skills.find((e) => e.name === want) ??
            data.skills.find((e) => e.name.toLowerCase() === want.toLowerCase()) ??
            data.skills.find((e) => e.name.endsWith(`:${want}`));
        if (!hit) {
            // 처음 받은(모아 둔) 목록에 없으면 새 목록을 기다린다 — 그래도 없으면 알린다
            if (!loading) {
                focusDone.current = true;
                setFocusMiss(want);
            }
            return;
        }
        focusDone.current = true;
        setFocusMiss(null);
        setQuery("");
        setCreating(false);
        setSelected(hit.id);
        window.setTimeout(() => rowRefs.current.get(hit.id)?.scrollIntoView({block: "center"}), 30);
    }, [focus, data, loading]);

    // Esc: 새 스킬 창 → 검색어 순서로 먼저 받는다 (창은 preventDefault된 Esc를 무시한다). 둘 다 없으면 창이 닫힌다.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
            if (creating) {
                e.preventDefault();
                setCreating(false);
            } else if (query) {
                e.preventDefault();
                setQuery("");
                searchRef.current?.blur();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [creating, query]);

    const groups = useMemo(() => {
        if (!data) return [];
        const q = query.trim();
        return groupsOf(data.skills.filter((e) => matches(e, q)), data.project, data.personalDir).filter((g) => g.items.length > 0);
    }, [data, query]);

    const current = data?.skills.find((e) => e.id === selected) ?? null;
    const alwaysOn = data ? data.skills.reduce((n, e) => n + (e.tokens ?? 0), 0) : 0;
    const counts = data ? {all: data.skills.length, mine: data.skills.filter((e) => e.editable).length} : null;

    const afterCreate = (path: string) => {
        setCreating(false);
        void load().then(() => setSelected(path));
        setSelected(path);
    };

    let listBody: React.ReactNode;
    if (!list) {
        listBody = (
            <div className={cx("skNotice")}>
                <FontAwesomeIcon icon={faCircleNotch} spin /> 이 폴더의 스킬을 확인하는 중…
            </div>
        );
    } else if (list.ok === false) {
        listBody = <div className={cx("skNotice")}>스킬 목록을 받지 못했습니다 — {list.error}</div>;
    } else if (groups.length === 0) {
        listBody = <div className={cx("skNotice")}>{query ? `‘${query}’에 맞는 스킬이 없습니다.` : "이 폴더에서 쓸 수 있는 스킬이 없습니다."}</div>;
    } else {
        listBody = groups.map((g) => {
            const tokens = groupTokens(g.items);
            return (
                <section key={g.key} className={cx("skGroup")}>
                    <div className={cx("skGroupHead")}>
                        <span className={cx("skGroupTitle")}>{g.title}</span>
                        <span className={cx("skGroupCount")}>{g.items.length}</span>
                        {tokens !== null && tokens > 0 && <span className={cx("skGroupTokens")}>늘 {compactTokens(tokens)} 토큰</span>}
                    </div>
                    <div className={cx("skGroupHint")} title={g.full}>
                        {g.hint}
                    </div>
                    {g.items.map((e) => (
                        <SkillRow
                            key={e.id}
                            entry={e}
                            cwd={data?.cwd ?? cwd}
                            active={e.id === selected && !creating}
                            onPick={() => {
                                setCreating(false);
                                setSelected(e.id);
                            }}
                            rowRef={(el) => {
                                if (el) rowRefs.current.set(e.id, el);
                                else rowRefs.current.delete(e.id);
                            }}
                        />
                    ))}
                </section>
            );
        });
    }

    const showDetail = creating || !!current;

    return (
        <TabIdContext.Provider value={tabId}>
            <div className={cx("skTab")}>
                <div className={cx("skToolbar")}>
                    <div className={cx("skSearch")}>
                        <FontAwesomeIcon icon={faMagnifyingGlass} className={cx("skSearchIcon")} />
                        <input
                            ref={searchRef}
                            className={cx("skSearchInput")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="스킬 찾기 (이름·설명)"
                            spellCheck={false}
                        />
                    </div>
                    {data && counts && (
                        <span
                            className={cx("skSummary")}
                            title="스킬마다 이름과 설명이 새 대화의 컨텍스트에 늘 들어갑니다. 본문은 쓸 때만 읽습니다."
                        >
                            스킬 {counts.all}개 · 늘 {data.measured ? compactTokens(alwaysOn) : "?"} 토큰
                        </span>
                    )}
                    <button
                        className={cx("skToolBtn", "skToolBtnPrimary")}
                        onClick={() => {
                            setCreating(true);
                            setFocusMiss(null);
                        }}
                        disabled={!data}
                    >
                        <FontAwesomeIcon icon={faPlus} /> 새 스킬
                    </button>
                    <button className={cx("skToolBtn")} onClick={() => void load(true)} disabled={loading} title="다시 확인 (CLI에 다시 묻습니다)">
                        <FontAwesomeIcon icon={faArrowsRotate} spin={loading} />
                    </button>
                </div>
                <div className={cx("skSplit", {skHasSel: showDetail})}>
                    <div className={cx("skList")}>
                        <div className={cx("skIntro")}>
                            <FontAwesomeIcon icon={faBook} className={cx("skIntroIcon")} />
                            <span>
                                스킬은 서랍 속 매뉴얼입니다. <b>이름과 설명</b>만 늘 Claude에게 보이고, 본문은 쓸 때 읽습니다. 입력창에{" "}
                                <code>/이름</code>으로 직접 부를 수도 있습니다.
                            </span>
                        </div>
                        {focusMiss && (
                            <div className={cx("skWarn")}>
                                <FontAwesomeIcon icon={faTriangleExclamation} />
                                <span>
                                    이 폴더에서 <code>{focusMiss}</code> 스킬을 찾지 못했습니다 — 다른 폴더의 스킬이거나 지워졌습니다.
                                </span>
                            </div>
                        )}
                        {data && data.includedSkills !== undefined && data.totalSkills !== undefined && data.includedSkills < data.totalSkills && (
                            <div className={cx("skWarn")}>
                                <FontAwesomeIcon icon={faTriangleExclamation} />
                                <span>
                                    스킬이 많아 {data.totalSkills - data.includedSkills}개는 설명이 컨텍스트에 들어가지 못했습니다 — Claude가 그 스킬을
                                    스스로 떠올리지 못할 수 있습니다.
                                </span>
                            </div>
                        )}
                        {listBody}
                    </div>
                    <div className={cx("skDetail")}>
                        {creating && data ? (
                            <SkillCreate tabId={tabId} data={data} onCancel={() => setCreating(false)} onCreated={afterCreate} />
                        ) : current ? (
                            <SkillDetail
                                key={current.id}
                                tabId={tabId}
                                entry={current}
                                cwd={data?.cwd ?? cwd}
                                onBack={() => setSelected(null)}
                                onSaved={() => void load()}
                            />
                        ) : (
                            <div className={cx("skEmptyDetail")}>
                                <FontAwesomeIcon icon={faHandPointer} className={cx("skEmptyIcon")} />
                                <div>왼쪽에서 스킬을 고르면 내용과 부르는 법을 봅니다.</div>
                                {counts && counts.mine === 0 && (
                                    <button className={cx("skLinkBtn")} onClick={() => setCreating(true)}>
                                        내 스킬을 처음 만들어 보기
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </TabIdContext.Provider>
    );
}

// ── 목록 한 줄 ──
function SkillRow({
    entry: e,
    cwd,
    active,
    onPick,
    rowRef,
}: {
    entry: SkillEntry;
    cwd: string;
    active: boolean;
    onPick: () => void;
    rowRef: (el: HTMLButtonElement | null) => void;
}) {
    const where = whereLabel(e, cwd);
    return (
        <button ref={rowRef} className={cx("skRow", {skRowActive: active})} onClick={onPick} aria-current={active ? "true" : undefined}>
            <span className={cx("skRowHead")}>
                <span className={cx("skRowName")}>
                    <MiddleName name={e.name} />
                </span>
                {e.path && drafts.has(e.path) && <span className={cx("skDraftDot")} title="저장하지 않은 고침이 있습니다" />}
                {!e.loaded && (
                    <span className={cx("skBadge", "skBadgeWarn")} title="CLI가 이 파일을 스킬로 읽지 않았습니다 — 이름이 겹치거나 형식이 틀렸을 수 있습니다">
                        안 읽힘
                    </span>
                )}
                <span className={cx("skRowTokens")} title="새 대화에 늘 들어가는 토큰 (이름 + 설명)">
                    {e.tokens === null ? "" : `${e.tokens.toLocaleString()} 토큰`}
                </span>
            </span>
            {e.description && <span className={cx("skRowDesc")}>{e.description}</span>}
            <span className={cx("skRowFoot")}>
                {e.userInvocable ? <code className={cx("skCall")}>/{e.name}</code> : <span className={cx("skMuted")}>Claude만 부름</span>}
                {e.manualOnly && <span className={cx("skBadge", "skBadgeManual")}>직접 부를 때만</span>}
                {e.paths && e.paths.length > 0 && (
                    <span className={cx("skBadge")} title={`맞는 파일을 다룰 때만 불려 옵니다: ${e.paths.join(", ")}`}>
                        파일 조건
                    </span>
                )}
                {where && (
                    <span className={cx("skWhere")} title={e.base}>
                        {where}
                    </span>
                )}
            </span>
        </button>
    );
}

// ── 스킬 하나: 내용 보기 / 편집 / 폴더의 다른 파일 ──
interface Loaded {
    content: string;
    mtimeMs: number;
    readOnly: boolean;
    files: {rel: string; size: number}[];
    filesTruncated: boolean;
}

function SkillDetail({
    tabId,
    entry: e,
    cwd,
    onBack,
    onSaved,
}: {
    tabId: string;
    entry: SkillEntry;
    cwd: string;
    onBack: () => void;
    onSaved: () => void;
}) {
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [text, setText] = useState("");
    const [base, setBase] = useState<number | null>(null);
    const [mode, setMode] = useState<"view" | "edit">("view");
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<{kind: "ok" | "error"; text: string} | null>(null);
    const [conflict, setConflict] = useState<{exists: boolean} | null>(null);
    const [copied, setCopied] = useState(false);
    const [other, setOther] = useState<{rel: string; text?: string; error?: string} | null>(null);
    const textRef = useRef(text);
    textRef.current = text;
    const path = e.path;

    const read = useCallback(
        async (keepDraft: boolean) => {
            if (!path) return;
            const r: SkillFileRead = await window.electronAPI
                .readSkillFile(tabId, path)
                .catch((err: unknown) => ({ok: false as const, error: String(err)}));
            if (r.ok === false) {
                setError(r.error);
                return;
            }
            setError(null);
            setLoaded({content: r.content, mtimeMs: r.mtimeMs, readOnly: r.readOnly, files: r.files ?? [], filesTruncated: !!r.filesTruncated});
            const d = keepDraft ? drafts.get(path) : undefined;
            if (d && !r.readOnly) {
                setText(d.text);
                setBase(d.base);
                setMode("edit");
            } else {
                drafts.delete(path);
                setText(r.content);
                setBase(r.mtimeMs);
            }
        },
        [tabId, path]
    );

    useEffect(() => {
        void read(true);
    }, [read]);

    const dirty = loaded !== null && text !== loaded.content;

    const change = (v: string) => {
        setText(v);
        setStatus(null);
        if (!path) return;
        if (loaded && v !== loaded.content) drafts.set(path, {text: v, base});
        else drafts.delete(path);
    };

    const save = async (force = false) => {
        if (!loaded || saving || !path) return;
        const content = textRef.current;
        setSaving(true);
        setConflict(null);
        const r: SkillFileWrite = await window.electronAPI
            .writeSkillFile(tabId, path, content, base, force)
            .catch((err: unknown) => ({ok: false as const, error: String(err)}));
        setSaving(false);
        if (r.ok === true) {
            drafts.delete(path);
            setLoaded({...loaded, content, mtimeMs: r.mtimeMs});
            setBase(r.mtimeMs);
            setStatus({kind: "ok", text: "저장했습니다 — 다음 메시지부터 새 내용을 씁니다"});
            onSaved();
        } else if (r.conflict) {
            setConflict({exists: r.exists !== false});
        } else {
            setStatus({kind: "error", text: r.error ?? "저장하지 못했습니다"});
        }
    };

    const revert = () => {
        if (!loaded || !path) return;
        drafts.delete(path);
        setText(loaded.content);
        setBase(loaded.mtimeMs);
        setStatus(null);
        setConflict(null);
    };

    const reload = () => {
        if (path) drafts.delete(path);
        setConflict(null);
        setStatus(null);
        void read(false);
    };

    const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isImeComposing(ev)) return;
        // 한글 입력 상태에서도 ⌘S가 되게 키 위치(code)로도 본다
        if ((ev.metaKey || ev.ctrlKey) && (ev.key.toLowerCase() === "s" || ev.code === "KeyS")) {
            ev.preventDefault();
            void save();
        }
    };

    const openOther = async (rel: string) => {
        if (!e.dir) return;
        setOther({rel});
        const r = await window.electronAPI.readSkillFile(tabId, `${e.dir}/${rel}`).catch((err: unknown) => ({ok: false as const, error: String(err)}));
        setOther(r.ok === true ? {rel, text: r.content} : {rel, error: r.error});
    };

    const call = `/${e.name}${e.argumentHint ? ` ${e.argumentHint}` : ""}`;
    const copyCall = () => {
        void copyText(`/${e.name} `).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    };
    const readOnly = loaded?.readOnly ?? !e.editable;
    const body = stripFrontmatter(text);
    const where = whereLabel(e, cwd);

    return (
        <div className={cx("skDetailInner")}>
            <div className={cx("skDetailHead")}>
                <button className={cx("skBackBtn")} onClick={onBack} title="목록으로">
                    <FontAwesomeIcon icon={faArrowLeft} />
                </button>
                <div className={cx("skDetailTitleBox")}>
                    <div className={cx("skDetailTitle")}>
                        <MiddleName name={e.name} />
                    </div>
                    <div className={cx("skDetailBadges")}>
                        <span className={cx("skBadge", e.editable ? "skBadgeMine" : "")}>{scopeLabel(e)}</span>
                        {e.manualOnly && <span className={cx("skBadge", "skBadgeManual")}>직접 부를 때만</span>}
                        {!e.userInvocable && <span className={cx("skBadge")}>Claude만 부름</span>}
                        {where && <span className={cx("skWhere")}>{where}</span>}
                    </div>
                </div>
                <div className={cx("skTokenBox")} title="새 대화의 컨텍스트에 늘 들어가는 몫 — 이 스킬의 이름과 설명">
                    <span className={cx("skTokenNum")}>{e.tokens === null ? "?" : e.tokens.toLocaleString()}</span>
                    <span className={cx("skTokenLabel")}>늘 드는 토큰</span>
                </div>
            </div>

            <div className={cx("skDetailScroll")}>
                {e.description ? <p className={cx("skDesc")}>{e.description}</p> : <p className={cx("skDesc", "skMuted")}>설명이 없습니다.</p>}
                {e.whenToUse && (
                    <p className={cx("skWhen")}>
                        <b>언제</b> {e.whenToUse}
                    </p>
                )}

                <div className={cx("skHow")}>
                    {e.userInvocable ? (
                        <div className={cx("skHowCall")}>
                            <code className={cx("skHowCode")}>{call}</code>
                            <button className={cx("skMiniBtn")} onClick={copyCall} title="입력창에 붙여 넣을 /이름을 복사">
                                <FontAwesomeIcon icon={copied ? faCheck : faCopy} /> {copied ? "복사됨" : "복사"}
                            </button>
                        </div>
                    ) : null}
                    <div className={cx("skHowText")}>
                        {e.manualOnly
                            ? `Claude는 이 스킬을 스스로 꺼내 쓰지 않습니다 — 입력창에 /${e.name}을(를) 쳐야 씁니다. 그래서 늘 드는 토큰도 없습니다.`
                            : e.userInvocable
                              ? `Claude가 설명을 보고 필요하다고 판단하면 스스로 꺼내 씁니다. 바로 쓰게 하려면 입력창에 /${e.name}을(를) 칩니다${
                                    e.argumentHint ? ` (뒤에 ${e.argumentHint})` : ""
                                }.`
                              : "Claude가 설명을 보고 필요할 때만 씁니다 — 입력창의 / 메뉴에는 나오지 않습니다."}
                    </div>
                    {e.paths && e.paths.length > 0 && (
                        <div className={cx("skHowText")}>
                            이 파일들을 다룰 때만 불려 옵니다: {e.paths.map((p) => <code key={p} className={cx("skInlineCode")}>{p}</code>)}
                        </div>
                    )}
                </div>

                {!e.loaded && (
                    <div className={cx("skWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>
                            CLI가 이 파일을 스킬로 읽지 않았습니다 — 같은 이름의 스킬이 있거나 맨 위 <code>---</code> 사이의 형식이 틀렸을 수 있습니다. 고친
                            뒤 ↻로 다시 확인하세요.
                        </span>
                    </div>
                )}

                {e.path ? (
                    <div className={cx("skFileBar")}>
                        {/* SKILL.md 스킬은 폴더를 보인다 — 줄여도 끝(스킬 폴더 이름)이 남게 (파일 이름은 늘 SKILL.md) */}
                        <span className={cx("skFilePath")} title={e.path}>
                            <MiddleName name={tildePath(e.dir ?? e.path)} />
                        </span>
                        <button className={cx("skMiniBtn")} onClick={() => void window.electronAPI.revealSkill(tabId, e.dir ?? e.path ?? "")} title="Finder에서 보기">
                            <FontAwesomeIcon icon={faFolderOpen} /> Finder
                        </button>
                    </div>
                ) : (
                    <div className={cx("skHint")}>
                        <FontAwesomeIcon icon={faCircleInfo} />
                        <span>
                            {e.scope === "builtin"
                                ? "Claude Code에 들어 있는 스킬이라 파일이 없습니다 — 쓸 때 CLI가 꺼냅니다."
                                : "이 스킬의 파일 위치를 CLI가 알려 주지 않았습니다."}
                        </span>
                    </div>
                )}

                {e.path && readOnly && loaded && (
                    <div className={cx("skHint")}>
                        <FontAwesomeIcon icon={faCircleInfo} />
                        <span>
                            {e.scope === "plugin"
                                ? "플러그인의 스킬입니다 — 플러그인을 업데이트하면 다시 덮어써지므로 여기서는 고치지 않습니다."
                                : e.scope === "managed"
                                  ? "관리자가 넣은 스킬이라 고칠 수 없습니다."
                                  : e.scope === "synced"
                                    ? "claude.ai에서 받은 스킬이라 여기서 고치지 않습니다."
                                    : "읽기만 할 수 있는 스킬입니다."}
                        </span>
                    </div>
                )}

                {e.path && (
                    <>
                        {loaded && !readOnly && !other && (
                            <div className={cx("skModeBar")}>
                                <button className={cx("skModeBtn", {skModeActive: mode === "view"})} onClick={() => setMode("view")}>
                                    <FontAwesomeIcon icon={faEye} /> 보기
                                </button>
                                <button className={cx("skModeBtn", {skModeActive: mode === "edit"})} onClick={() => setMode("edit")}>
                                    <FontAwesomeIcon icon={faPen} /> 편집
                                </button>
                                <span className={cx("skModeNote")}>{mode === "edit" ? "맨 위 --- 사이가 이름·설명(늘 보임), 아래가 본문(쓸 때 읽음)" : ""}</span>
                            </div>
                        )}
                        {error ? (
                            <div className={cx("skNotice")}>{error}</div>
                        ) : !loaded ? (
                            <div className={cx("skNotice")}>
                                <FontAwesomeIcon icon={faCircleNotch} spin /> 읽는 중…
                            </div>
                        ) : other ? (
                            <div className={cx("skOther")}>
                                <div className={cx("skOtherHead")}>
                                    <button className={cx("skMiniBtn")} onClick={() => setOther(null)}>
                                        <FontAwesomeIcon icon={faArrowLeft} /> SKILL.md
                                    </button>
                                    <span className={cx("skOtherName")}>
                                        <MiddleName name={other.rel} />
                                    </span>
                                    <span className={cx("skMuted")}>읽기 전용</span>
                                </div>
                                {other.error ? (
                                    <div className={cx("skNotice")}>{other.error}</div>
                                ) : other.text === undefined ? (
                                    <div className={cx("skNotice")}>
                                        <FontAwesomeIcon icon={faCircleNotch} spin /> 읽는 중…
                                    </div>
                                ) : /\.(md|markdown|mdx)$/i.test(other.rel) ? (
                                    <ImageViewer tabId={tabId}>
                                        <div className={sx("bubble", "markdown", "instrMarkdown")}>
                                            <Markdown text={stripFrontmatter(other.text)} baseDir={dirOf(`${e.dir}/${other.rel}`)} />
                                        </div>
                                    </ImageViewer>
                                ) : (
                                    <pre className={cx("skPre")}>{other.text}</pre>
                                )}
                            </div>
                        ) : mode === "edit" && !readOnly ? (
                            <textarea
                                className={cx("skEditor")}
                                value={text}
                                onChange={(ev) => change(ev.target.value)}
                                onKeyDown={onKeyDown}
                                spellCheck={false}
                                autoFocus
                            />
                        ) : body.trim() ? (
                            <ImageViewer tabId={tabId}>
                                <div className={sx("bubble", "markdown", "instrMarkdown")}>
                                    <Markdown text={body} baseDir={e.dir ?? dirOf(e.path)} />
                                </div>
                            </ImageViewer>
                        ) : (
                            <div className={cx("skNotice")}>본문이 비어 있습니다.</div>
                        )}

                        {conflict && (
                            <div className={cx("skConflict")}>
                                <div className={cx("skConflictMsg")}>
                                    <FontAwesomeIcon icon={faTriangleExclamation} />
                                    <span>
                                        {conflict.exists
                                            ? "연 뒤에 다른 곳(Claude나 편집기)에서 이 파일이 바뀌었습니다. 다시 불러오면 내 고침은 버려집니다."
                                            : "연 뒤에 이 파일이 지워졌습니다."}
                                    </span>
                                </div>
                                <div className={cx("skConflictActions")}>
                                    <button className={cx("skBtn")} onClick={reload}>
                                        다시 불러오기
                                    </button>
                                    <button className={cx("skBtn", "skBtnDanger")} onClick={() => void save(true)}>
                                        {conflict.exists ? "그래도 덮어쓰기" : "다시 만들기"}
                                    </button>
                                </div>
                            </div>
                        )}

                        {loaded && !readOnly && !other && (mode === "edit" || dirty || status) && (
                            <div className={cx("skFooter")}>
                                <span className={cx("skStatus", {skStatusError: status?.kind === "error"})}>
                                    {saving ? (
                                        "저장하는 중…"
                                    ) : status ? (
                                        status.text
                                    ) : dirty ? (
                                        <>
                                            <i className={cx("skDraftDot")} /> 저장 안 함
                                        </>
                                    ) : null}
                                </span>
                                {dirty && (
                                    <button className={cx("skBtn")} onClick={revert}>
                                        <FontAwesomeIcon icon={faRotateLeft} /> 되돌리기
                                    </button>
                                )}
                                {(mode === "edit" || dirty) && (
                                    <button className={cx("skBtn", "skBtnPrimary")} onClick={() => void save()} disabled={saving || !dirty}>
                                        <FontAwesomeIcon icon={faFloppyDisk} /> 저장 <span className={cx("skKbd")}>⌘S</span>
                                    </button>
                                )}
                            </div>
                        )}

                        {loaded && e.dir && !other && (
                            <div className={cx("skFiles")}>
                                <div className={cx("skFilesTitle")}>
                                    스킬 폴더의 다른 파일 · {loaded.files.length}
                                    {loaded.filesTruncated ? "+" : ""}
                                </div>
                                {loaded.files.length === 0 ? (
                                    <div className={cx("skMuted", "skFilesEmpty")}>SKILL.md 하나뿐입니다.</div>
                                ) : (
                                    loaded.files.map((f) => (
                                        <button key={f.rel} className={cx("skFileRow")} onClick={() => void openOther(f.rel)} title={`${e.dir}/${f.rel}`}>
                                            <FontAwesomeIcon icon={faFileLines} className={cx("skFileIcon")} />
                                            <span className={cx("skFileName")}>
                                                <MiddleName name={f.rel} />
                                            </span>
                                            <span className={cx("skFileSize")}>{sizeLabel(f.size)}</span>
                                        </button>
                                    ))
                                )}
                                <div className={cx("skFilesNote")}>본문에서 이 파일들을 가리키면 Claude가 필요할 때 엽니다.</div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// ── 새 스킬 만들기 ──
const BODY_TEMPLATE = (name: string) =>
    `# ${name || "스킬 이름"}\n\n이 스킬을 쓸 때는 아래 순서대로 합니다.\n\n1. 먼저 할 일\n2. 그다음 할 일\n3. 마지막으로 확인할 것\n`;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function SkillCreate({
    tabId,
    data,
    onCancel,
    onCreated,
}: {
    tabId: string;
    data: ListOk;
    onCancel: () => void;
    onCreated: (path: string) => void;
}) {
    const projectOk = data.project.ok === true;
    const [scope, setScope] = useState<"personal" | "project">(projectOk ? "project" : "personal");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [body, setBody] = useState(() => BODY_TEMPLATE(""));
    const [bodyTouched, setBodyTouched] = useState(false);
    const [manualOnly, setManualOnly] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 본문을 고치기 전이면 제목 줄이 이름을 따라간다
    useEffect(() => {
        if (!bodyTouched) setBody(BODY_TEMPLATE(name));
    }, [name, bodyTouched]);

    const taken = useMemo(() => new Set(data.takenNames), [data.takenNames]);
    const nameError = !name
        ? null
        : !NAME_RE.test(name)
          ? "영문 소문자·숫자와 - 만 씁니다 (예: write-pr)"
          : name.length > 64
            ? "64자 이하로"
            : taken.has(name)
              ? `/${name}은(는) 이미 있는 이름입니다`
              : null;
    const dir = scope === "personal" ? data.personalDir : data.project.ok === true ? data.project.dir : "";
    const target = `${dir}/${name || "이름"}/SKILL.md`;
    const canSubmit = !!name && !nameError && !!description.trim() && !busy && (scope === "personal" || projectOk);

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        const r: SkillCreateResult = await window.electronAPI
            .createSkill(tabId, {scope, name, description: description.trim(), body, manualOnly})
            .catch((e: unknown) => ({ok: false as const, error: String(e)}));
        setBusy(false);
        if (r.ok === true) onCreated(r.path);
        else setError(r.error);
    };

    const onEnter = (e: React.KeyboardEvent) => {
        if (isImeComposing(e)) return;
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
        }
    };

    return (
        <div className={cx("skDetailInner")}>
            <div className={cx("skDetailHead")}>
                <button className={cx("skBackBtn")} onClick={onCancel} title="목록으로">
                    <FontAwesomeIcon icon={faArrowLeft} />
                </button>
                <div className={cx("skDetailTitleBox")}>
                    <div className={cx("skDetailTitle")}>새 스킬 만들기</div>
                    <div className={cx("skCreateLead")}>이름과 설명만 늘 Claude에게 보이고, 본문은 쓸 때 읽습니다.</div>
                </div>
                <button className={cx("skCloseBtn")} onClick={onCancel} title="닫기 (Esc)">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            <div className={cx("skDetailScroll")}>
                <div className={cx("skField")}>
                    <div className={cx("skLabel")}>어디에</div>
                    <label className={cx("skChoice", {skChoiceOn: scope === "personal"})}>
                        <input type="radio" name="sk-scope" checked={scope === "personal"} onChange={() => setScope("personal")} />
                        <span className={cx("skChoiceText")}>
                            <span>
                                <b>개인</b> — 어느 폴더에서 대화하든 씁니다
                            </span>
                            <span className={cx("skChoicePath")}>
                                <MiddleName name={tildePath(data.personalDir)} />
                            </span>
                        </span>
                    </label>
                    <label className={cx("skChoice", {skChoiceOn: scope === "project", skChoiceOff: !projectOk})}>
                        <input
                            type="radio"
                            name="sk-scope"
                            checked={scope === "project"}
                            disabled={!projectOk}
                            onChange={() => setScope("project")}
                        />
                        <span className={cx("skChoiceText")}>
                            <span>
                                <b>이 프로젝트</b> —{" "}
                                {data.project.ok === true
                                    ? data.project.kind === "folder"
                                        ? "이 폴더에서 대화할 때 씁니다 (git 저장소가 아닙니다)"
                                        : "이 저장소에서 대화할 때 씁니다 · git으로 함께 씁니다"
                                    : data.project.reason}
                            </span>
                            {data.project.ok === true && (
                                <span className={cx("skChoicePath")}>
                                    <MiddleName name={tildePath(data.project.dir)} />
                                </span>
                            )}
                            {data.project.ok === true && data.project.kind === "worktree-main" && (
                                <span className={cx("skChoiceNote")}>작업 트리라 원래 저장소의 .claude/skills에 만듭니다 (CLI가 거기를 읽습니다)</span>
                            )}
                        </span>
                    </label>
                </div>

                <div className={cx("skField")}>
                    <label className={cx("skLabel")} htmlFor="sk-name">
                        이름
                    </label>
                    <div className={cx("skNameRow")}>
                        <span className={cx("skNameSlash")}>/</span>
                        <input
                            id="sk-name"
                            className={cx("skInput", "skNameInput", {skInputBad: !!nameError})}
                            value={name}
                            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
                            onKeyDown={onEnter}
                            placeholder="write-pr"
                            spellCheck={false}
                            autoFocus
                        />
                    </div>
                    <div className={cx("skFieldHint", {skFieldBad: !!nameError})}>
                        {nameError ?? "영문 소문자·숫자·- — 입력창에서 이 이름으로 부릅니다. 폴더 이름도 됩니다."}
                    </div>
                </div>

                <div className={cx("skField")}>
                    <label className={cx("skLabel")} htmlFor="sk-desc">
                        설명 <span className={cx("skRequired")}>꼭 적기</span>
                    </label>
                    <textarea
                        id="sk-desc"
                        className={cx("skInput", "skDescInput")}
                        value={description}
                        onChange={(e) => setDescription(e.target.value.replace(/\n/g, " "))}
                        onKeyDown={onEnter}
                        rows={2}
                        placeholder="언제 쓰는지 적습니다. 예) PR 설명을 쓸 때 — 바뀐 점·이유·확인 방법 순서로 정리한다"
                    />
                    <div className={cx("skFieldHint")}>Claude는 이 설명만 보고 이 스킬을 꺼낼지 정합니다 — 언제 쓰는지가 드러나게.</div>
                </div>

                <div className={cx("skField")}>
                    <label className={cx("skLabel")} htmlFor="sk-body">
                        본문 <span className={cx("skMuted")}>쓸 때 읽는 매뉴얼 — 순서대로 적으면 따라 합니다</span>
                    </label>
                    <textarea
                        id="sk-body"
                        className={cx("skInput", "skBodyInput")}
                        value={body}
                        onChange={(e) => {
                            setBody(e.target.value);
                            setBodyTouched(true);
                        }}
                        spellCheck={false}
                    />
                </div>

                <label className={cx("skCheck")}>
                    <input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} />
                    <span>
                        <b>직접 부를 때만 부르기</b>
                        <span className={cx("skCheckNote")}>
                            Claude가 스스로 꺼내 쓰지 않고, 입력창에 /{name || "이름"}을(를) 칠 때만 씁니다. 늘 드는 토큰도 없습니다.
                        </span>
                    </span>
                </label>

                <div className={cx("skTarget")}>
                    <span className={cx("skMuted")}>만들 파일</span>
                    <span className={cx("skTargetPath")} title={target}>
                        <MiddleName name={tildePath(target)} />
                    </span>
                </div>

                {error && (
                    <div className={cx("skWarn")}>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        <span>{error}</span>
                    </div>
                )}

                <div className={cx("skFooter", "skCreateFooter")}>
                    <span className={cx("skStatus")}>{busy ? "만드는 중…" : "있는 파일은 덮어쓰지 않습니다"}</span>
                    <button className={cx("skBtn")} onClick={onCancel}>
                        취소
                    </button>
                    <button className={cx("skBtn", "skBtnPrimary")} onClick={() => void submit()} disabled={!canSubmit}>
                        <FontAwesomeIcon icon={faPlus} /> 만들기
                    </button>
                </div>
            </div>
        </div>
    );
}
