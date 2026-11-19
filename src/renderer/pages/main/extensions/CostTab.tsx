import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faChevronRight, faRotateRight, faSpinner} from "@fortawesome/free-solid-svg-icons";
import styles from "./extensions.module.scss";
import {MiddleName} from "../MiddleName";
import {type ExtensionsTabProps, openExtensions} from "../../../extensions-open";
import {useExtensionsHost} from "./extensions-host";

const cx = classNames.bind(styles);

// 대화 시작 비용 — 이 폴더에서 새 대화 하나가 아무 말도 하기 전에 쓰는 토큰과, 그게 무엇에서 오는지.
// main이 대화 없는 CLI에 getContextUsage("full")로 묻는다(지침 패널과 같은 측정, MCP 연결을 기다린 것) — 토큰 세기 API로 센 값이다.

// 분류 줄의 이름 (CLI의 id 기준 — 영어 이름은 바뀔 수 있다)
const CATEGORY: Record<string, {label: string; hint: string}> = {
    system_prompt: {label: "시스템 프롬프트", hint: "Claude Code의 기본 지시와 앱에 넣은 시스템 프롬프트"},
    system_tools: {label: "기본 도구", hint: "Read·Edit·Bash 같은 도구 설명 — 늘 들어갑니다"},
    mcp_tools: {label: "MCP 도구", hint: "MCP 서버가 준 도구 설명 중 처음부터 들어가는 것"},
    mcp_instructions: {label: "MCP 서버 안내문", hint: "MCP 서버가 Claude에게 주는 사용 안내"},
    custom_agents: {label: "에이전트", hint: "직접 만들었거나 플러그인이 준 에이전트의 이름·설명"},
    memory_files: {label: "지침 파일", hint: "CLAUDE.md·기억 목록 — 대화마다 통째로 들어갑니다"},
    skills: {label: "스킬", hint: "스킬마다 이름과 설명만 — 본문은 Claude가 그 스킬을 부를 때 듭니다"},
    messages: {label: "메시지", hint: "대화 내용 — 새 대화에는 거의 없습니다"},
};

const MEMORY_TYPE: Record<string, string> = {
    Project: "프로젝트",
    Local: "나만(로컬)",
    User: "사용자 공통",
    Managed: "관리 정책",
    AutoMem: "기억 목록",
};

const SKILL_SOURCE: Record<string, string> = {
    userSettings: "내 스킬 — 모든 프로젝트",
    projectSettings: "이 프로젝트 스킬",
    localSettings: "나만(로컬) 스킬",
    policySettings: "관리 정책 스킬",
    "built-in": "Claude Code 기본 스킬",
    bundled: "Claude Code 기본 스킬",
};

const AGENT_SOURCE: Record<string, string> = {
    userSettings: "내 에이전트",
    projectSettings: "이 프로젝트",
    localSettings: "나만(로컬)",
    policySettings: "관리 정책",
    "built-in": "기본",
};

const MCP_STATUS: Record<string, string> = {
    "connected": "연결됨",
    "failed": "연결 실패",
    "needs-auth": "로그인 필요",
    "pending": "연결 중",
    "disabled": "꺼짐",
};

function pct(n: number, total: number): string {
    if (total <= 0) return "0%";
    const v = (n / total) * 100;
    return v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
}

function k(n: number): string {
    return n.toLocaleString();
}

// claude-haiku-5-5 → Haiku 5.5 (모르는 모양이면 그대로)
function modelLabel(id: string): string {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:$|-)/.exec(id);
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString("ko-KR", {hour: "2-digit", minute: "2-digit"});
}

// MCP 상태 이름(plugin:figma:figma)을 도구 목록의 서버 이름(plugin_figma_figma)처럼
function normalizeServer(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

// 플러그인이 준 MCP 서버면 그 플러그인 이름 (plugin:<플러그인>:<서버>)
function pluginOfServer(statusName: string): string | null {
    const m = /^plugin:([^:]+):/.exec(statusName);
    return m ? m[1] : null;
}

function Bar({value, max}: {value: number; max: number}) {
    const w = max > 0 ? Math.max(value > 0 ? 1.5 : 0, Math.min(100, (value / max) * 100)) : 0;
    return (
        <span className={cx("costBar")} aria-hidden>
            <span className={cx("costBarFill")} style={{width: `${w}%`}} />
        </span>
    );
}

interface SkillGroup {
    key: string;
    label: string;
    pluginId?: string;
    tokens: number;
    skills: StartCost["skills"];
}

export function CostTab({tabId}: ExtensionsTabProps) {
    const host = useExtensionsHost();
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);
    const [data, setData] = useState<StartCostResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState<Set<string>>(() => new Set());

    const load = useCallback(
        async (refresh: boolean) => {
            setLoading(true);
            const r = await window.electronAPI.getStartCost(tabId, refresh).catch((e) => ({ok: false as const, error: String(e?.message ?? e)}));
            if (!alive.current) return;
            setData(r);
            setLoading(false);
        },
        [tabId]
    );
    useEffect(() => {
        void load(false);
    }, [load]);

    const cost = data?.ok ? data : null;
    // 새 대화의 "메시지"(빈 자리 10토큰 남짓)는 시작 비용이라 하기 어려워 뺀다
    const used = useMemo(
        () =>
            (cost?.categories ?? [])
                .filter((c) => c.kind === "used" && c.tokens > 0 && !(c.id === "messages" && c.tokens < 100))
                .sort((a, b) => b.tokens - a.tokens),
        [cost]
    );
    const deferred = useMemo(() => (cost?.categories ?? []).filter((c) => c.kind === "deferred").reduce((n, c) => n + c.tokens, 0), [cost]);
    const top = used[0]?.tokens ?? 0;

    // 스킬: 플러그인마다 / 내 스킬 / 프로젝트 스킬 / 기본 스킬 … — 큰 묶음부터
    const skillGroups = useMemo<SkillGroup[]>(() => {
        const groups = new Map<string, SkillGroup>();
        for (const sk of cost?.skills ?? []) {
            const key = sk.source === "plugin" ? `plugin:${sk.pluginId ?? sk.pluginName ?? "?"}` : sk.source;
            let g = groups.get(key);
            if (!g) {
                g = {
                    key,
                    label: sk.source === "plugin" ? `플러그인 ${sk.pluginName ?? sk.pluginId ?? ""}` : SKILL_SOURCE[sk.source] ?? sk.source,
                    pluginId: sk.source === "plugin" ? sk.pluginId ?? sk.pluginName : undefined,
                    tokens: 0,
                    skills: [],
                };
                groups.set(key, g);
            }
            g.tokens += sk.tokens;
            g.skills.push(sk);
        }
        const list = [...groups.values()];
        for (const g of list) g.skills.sort((a, b) => b.tokens - a.tokens);
        return list.sort((a, b) => b.tokens - a.tokens);
    }, [cost]);
    const skillTotal = skillGroups.reduce((n, g) => n + g.tokens, 0);

    // MCP: 서버마다 도구 수·토큰(처음부터 드는 것 / 필요할 때만). 상태는 잴 때의 MCP 목록에서.
    const servers = useMemo(() => {
        const byServer = new Map<string, {name: string; status?: string; plugin: string | null; tools: number; loaded: number; deferred: number}>();
        for (const s of cost?.mcpServers ?? []) {
            byServer.set(normalizeServer(s.name), {name: s.name, status: s.status, plugin: pluginOfServer(s.name), tools: 0, loaded: 0, deferred: 0});
        }
        for (const t of cost?.mcpTools ?? []) {
            let g = byServer.get(t.serverName);
            if (!g) {
                g = {name: t.serverName, plugin: null, tools: 0, loaded: 0, deferred: 0};
                byServer.set(t.serverName, g);
            }
            g.tools += 1;
            if (t.loaded) g.loaded += t.tokens;
            else g.deferred += t.tokens;
        }
        return [...byServer.values()].sort((a, b) => b.loaded + b.deferred - (a.loaded + a.deferred));
    }, [cost]);
    const needsLogin = servers.filter((s) => s.status === "needs-auth");

    const toggle = (key: string) =>
        setOpen((s) => {
            const n = new Set(s);
            if (n.has(key)) n.delete(key);
            else n.add(key);
            return n;
        });

    return (
        <div className={cx("extPage")}>
            <div className={cx("costHead")}>
                <div className={cx("costHeadMain")}>
                    <div className={cx("costHeadLabel")}>새 대화를 시작하면 처음부터</div>
                    <div className={cx("costHeadTotal")}>
                        {cost ? (
                            <>
                                {k(cost.total)}
                                <span className={cx("costHeadUnit")}>토큰</span>
                            </>
                        ) : (
                            "—"
                        )}
                    </div>
                    {cost && (
                        <div className={cx("costHeadSub")}>
                            컨텍스트 창 {k(cost.max)}의 {pct(cost.total, cost.max)} · {modelLabel(cost.model)} 기준 · {clock(cost.measuredAt)}에 잼
                        </div>
                    )}
                </div>
                <button className={cx("extBtn")} onClick={() => void load(true)} disabled={loading}>
                    <FontAwesomeIcon icon={loading ? faSpinner : faRotateRight} spin={loading} /> 다시 재기
                </button>
            </div>
            <p className={cx("extLead")}>
                {cost && !cost.full
                    ? "자세히 세지 못해 어림값으로 보입니다 (토큰 세기를 쓸 수 없었습니다)."
                    : "CLI에게 직접 세게 한 값입니다 — 어림값이 아니라 토큰 세기 API로 센 것이고, 재는 데 대화 비용은 들지 않습니다."}{" "}
                이 폴더·이 탭의 모델·시스템 프롬프트 기준이고, 대화가 길어지면 그만큼 더 쌓입니다.
            </p>

            {!data ? (
                <div className={cx("extEmpty")}>
                    <FontAwesomeIcon icon={faSpinner} spin /> 재는 중… (MCP 서버 연결을 기다리느라 몇 초 걸릴 수 있습니다)
                </div>
            ) : data.ok === false ? (
                <div className={cx("extEmpty", "extEmptyError")}>{data.error}</div>
            ) : (
                <>
                    <section className={cx("costSection")}>
                        <h3 className={cx("costSectionTitle")}>무엇이 차지하나</h3>
                        <ul className={cx("costRows")}>
                            {used.map((c) => {
                                const info = (c.id && CATEGORY[c.id]) || {label: c.name, hint: ""};
                                return (
                                    <li key={c.id ?? c.name} className={cx("costRow")} title={info.hint || undefined}>
                                        <span className={cx("costRowName")}>{info.label}</span>
                                        <Bar value={c.tokens} max={top} />
                                        <span className={cx("costRowTokens")}>{k(c.tokens)}</span>
                                        <span className={cx("costRowPct")}>{pct(c.tokens, data.total)}</span>
                                    </li>
                                );
                            })}
                        </ul>
                        {deferred > 0 && (
                            <p className={cx("costNote")}>
                                필요할 때만 불러오는 도구 {k(deferred)} 토큰은 빠져 있습니다 — Claude가 그 도구를 찾을 때 그때그때 들어갑니다.
                            </p>
                        )}
                    </section>

                    {data.memoryFiles.length > 0 && (
                        <section className={cx("costSection")}>
                            <h3 className={cx("costSectionTitle")}>
                                지침 파일
                                <span className={cx("costSectionSum")}>{k(data.memoryFiles.reduce((n, f) => n + f.tokens, 0))}</span>
                                <button className={cx("extLinkBtn", "costSectionLink")} onClick={host.openInstructions}>
                                    지침 패널에서 보기·고치기
                                </button>
                            </h3>
                            <ul className={cx("costRows")}>
                                {[...data.memoryFiles]
                                    .sort((a, b) => b.tokens - a.tokens)
                                    .map((f) => (
                                        <li key={f.path} className={cx("costRow")}>
                                            <button className={cx("costRowName", "costRowLink")} onClick={host.openInstructions} title={`${f.path} — 지침 패널에서 열기`}>
                                                <span className={cx("extBadge")}>{MEMORY_TYPE[f.type] ?? f.type}</span>
                                                <span className={cx("costPath")}>
                                                    <MiddleName name={f.path} />
                                                </span>
                                            </button>
                                            <Bar value={f.tokens} max={top} />
                                            <span className={cx("costRowTokens")}>{k(f.tokens)}</span>
                                            <span className={cx("costRowPct")}>{pct(f.tokens, data.total)}</span>
                                        </li>
                                    ))}
                            </ul>
                        </section>
                    )}

                    {skillGroups.length > 0 && (
                        <section className={cx("costSection")}>
                            <h3 className={cx("costSectionTitle")}>
                                스킬 {data.skills.length}개<span className={cx("costSectionSum")}>{k(skillTotal)}</span>
                            </h3>
                            <ul className={cx("costRows")}>
                                {skillGroups.map((g) => {
                                    const isOpen = open.has(g.key);
                                    return (
                                        <li key={g.key} className={cx("costGroup")}>
                                            <div className={cx("costRow")}>
                                                <button className={cx("costRowName", "costRowLink")} onClick={() => toggle(g.key)} aria-expanded={isOpen}>
                                                    <FontAwesomeIcon icon={isOpen ? faChevronDown : faChevronRight} className={cx("costChevron")} />
                                                    {g.label}
                                                    <span className={cx("costCount")}>{g.skills.length}개</span>
                                                </button>
                                                <Bar value={g.tokens} max={top} />
                                                <span className={cx("costRowTokens")}>{k(g.tokens)}</span>
                                                <span className={cx("costRowPct")}>{pct(g.tokens, data.total)}</span>
                                            </div>
                                            {isOpen && (
                                                <ul className={cx("costSubRows")}>
                                                    {g.pluginId && (
                                                        <li className={cx("costSubAction")}>
                                                            <button className={cx("extLinkBtn")} onClick={() => openExtensions("plugins", g.pluginId)}>
                                                                플러그인 탭에서 이 플러그인 보기
                                                            </button>
                                                        </li>
                                                    )}
                                                    {g.skills.map((sk) => (
                                                        <li key={sk.name} className={cx("costSubRow")}>
                                                            <button className={cx("extLinkBtn")} onClick={() => openExtensions("skills", sk.name)} title="스킬 탭에서 보기">
                                                                {sk.name}
                                                            </button>
                                                            <span className={cx("costRowTokens")}>{k(sk.tokens)}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    )}

                    {servers.length > 0 && (
                        <section className={cx("costSection")}>
                            <h3 className={cx("costSectionTitle")}>
                                MCP 서버 {servers.length}개
                                <span className={cx("costSectionSum")}>{k(servers.reduce((n, s) => n + s.loaded, 0))}</span>
                            </h3>
                            <ul className={cx("costRows")}>
                                {servers.map((s) => (
                                    <li key={s.name} className={cx("costRow")}>
                                        <span className={cx("costRowName")}>
                                            {s.plugin ? (
                                                <button className={cx("extLinkBtn")} onClick={() => openExtensions("plugins", s.plugin as string)} title="플러그인 탭에서 보기">
                                                    {s.name}
                                                </button>
                                            ) : (
                                                s.name
                                            )}
                                            {s.status && (
                                                <span className={cx("extBadge", s.status === "connected" ? "extBadgeOk" : s.status === "needs-auth" ? "extBadgeWarn" : "extBadgeMuted")}>
                                                    {MCP_STATUS[s.status] ?? s.status}
                                                </span>
                                            )}
                                            <span className={cx("costCount")}>
                                                도구 {s.tools}개{s.deferred > 0 ? ` · 필요할 때만 ${k(s.deferred)}` : ""}
                                            </span>
                                        </span>
                                        <Bar value={s.loaded} max={top} />
                                        <span className={cx("costRowTokens")}>{k(s.loaded)}</span>
                                        <span className={cx("costRowPct")}>{pct(s.loaded, data.total)}</span>
                                    </li>
                                ))}
                            </ul>
                            {needsLogin.length > 0 && (
                                <p className={cx("costNote")}>
                                    로그인하지 않은 서버({needsLogin.map((s) => s.name).join(", ")})의 도구는 빠져 있습니다 — 로그인하면 늘어날 수 있습니다.{" "}
                                    <button className={cx("extLinkBtn")} onClick={host.openMcp}>
                                        MCP 목록 열기
                                    </button>
                                </p>
                            )}
                        </section>
                    )}

                    {data.agents.length > 0 && (
                        <section className={cx("costSection")}>
                            <h3 className={cx("costSectionTitle")}>
                                에이전트 {data.agents.length}개<span className={cx("costSectionSum")}>{k(data.agents.reduce((n, a) => n + a.tokens, 0))}</span>
                            </h3>
                            <ul className={cx("costRows")}>
                                {[...data.agents]
                                    .sort((a, b) => b.tokens - a.tokens)
                                    .map((a) => (
                                        <li key={`${a.source}:${a.agentType}`} className={cx("costRow")}>
                                            <span className={cx("costRowName")}>
                                                {a.agentType}
                                                {a.pluginId ? (
                                                    <button className={cx("extLinkBtn", "costCount")} onClick={() => openExtensions("plugins", a.pluginId)}>
                                                        플러그인 {a.pluginId.split("@")[0]}
                                                    </button>
                                                ) : (
                                                    <span className={cx("costCount")}>{AGENT_SOURCE[a.source] ?? a.source}</span>
                                                )}
                                            </span>
                                            <Bar value={a.tokens} max={top} />
                                            <span className={cx("costRowTokens")}>{k(a.tokens)}</span>
                                            <span className={cx("costRowPct")}>{pct(a.tokens, data.total)}</span>
                                        </li>
                                    ))}
                            </ul>
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
