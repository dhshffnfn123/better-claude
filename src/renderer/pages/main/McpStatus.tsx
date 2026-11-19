import {useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCircleNotch, faPlug, faRotateRight} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {cancelMcpLogin, forgetMcpLogin, loginMcp, useMcpLogins} from "../../mcp-login";

const cx = classNames.bind(styles);

const MCP_STATUS_LABELS: Record<string, string> = {
    connected: "연결됨",
    failed: "실패",
    "needs-auth": "인증 필요",
    pending: "연결 중",
    disabled: "꺼짐",
};

// 로그아웃은 HTTP·SSE 서버만 된다 — claude.ai 커넥터·stdio는 CLI가 "Cannot clear auth"로 거절한다
const LOGOUT_TRANSPORTS = new Set(["http", "sse"]);

function isLoggingIn(login: McpLoginState | undefined): boolean {
    return login?.phase === "starting" || login?.phase === "waiting";
}

interface RowError {
    error: string;
    detail?: string;
}

// 작업 폴더 줄의 "MCP 연결/전체" 표시 + 누르면 서버 목록. 인증이 필요한 서버는 여기서 바로 로그인한다(main의 "MCP 서버 로그인").
// openSignal: 바뀔 때마다 연다 (입력창의 /mcp)
export function McpStatus({
    tabId,
    servers,
    onList,
    openSignal = 0,
}: {
    tabId: string;
    servers: McpServer[];
    onList: (tabId: string, list: McpServer[]) => void;
    openSignal?: number;
}) {
    const [open, setOpen] = useState(false);
    // 처음 그릴 때 이미 올라가 있던 값으로는 열지 않는다 — 바뀌었을 때만
    const seenOpenSignal = useRef(openSignal);
    useEffect(() => {
        if (openSignal === seenOpenSignal.current) return;
        seenOpenSignal.current = openSignal;
        setOpen(true);
    }, [openSignal]);
    const [refreshing, setRefreshing] = useState(false);
    // 이 팝업에서 누른 다시 연결·로그아웃이 진행 중인 서버, 그리고 그 실패 문구
    const [busy, setBusy] = useState<Record<string, "reconnect" | "logout">>({});
    const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
    const logins = useMcpLogins();

    // 탭을 바꾸면 이전 탭의 팝업은 닫는다
    useEffect(() => {
        setOpen(false);
        setRowErrors({});
    }, [tabId]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    // 연결된 서버의 끝난 로그인 표시(오류·claude.ai 안내·로그인함)는 지운다 — 나중에 다시 "인증 필요"가 되면 처음부터 보이게
    useEffect(() => {
        for (const m of servers) {
            const login = logins[m.name];
            if (m.status === "connected" && login && !isLoggingIn(login)) forgetMcpLogin(m.name);
        }
    }, [servers, logins]);

    const setBusyFor = (name: string, what: "reconnect" | "logout" | null) =>
        setBusy((prev) => {
            const next = {...prev};
            if (what) next[name] = what;
            else delete next[name];
            return next;
        });

    const setRowError = (name: string, err: RowError | null) =>
        setRowErrors((prev) => {
            const next = {...prev};
            if (err) next[name] = err;
            else delete next[name];
            return next;
        });

    const refresh = async () => {
        const id = tabId;
        setRefreshing(true);
        // 지난 로그인 실패 문구·claude.ai 안내는 다시 확인하면 지운다 (그사이 터미널에서 켜거나 승인했을 수 있다).
        // 아직 인증 필요면 [로그인]이 다시 보인다 — claude.ai 커넥터면 그 설정 화면을 다시 연다.
        for (const m of servers) {
            const phase = logins[m.name]?.phase;
            if (phase === "error" || phase === "claudeai") forgetMcpLogin(m.name);
        }
        setRowErrors({});
        try {
            onList(id, await window.electronAPI.getMcpStatus(id, true));
        } finally {
            setRefreshing(false);
        }
    };

    // 실패한 서버 [다시 연결] · claude.ai 커넥터 [다시 확인] — 새 목록은 main이 chat:mcp로도 보낸다
    const reconnect = async (name: string) => {
        const id = tabId;
        setBusyFor(name, "reconnect");
        setRowError(name, null);
        try {
            const list = await window.electronAPI.reconnectMcp(id, name);
            if (list) onList(id, list);
        } finally {
            setBusyFor(name, null);
        }
    };

    const logout = async (name: string) => {
        const ok = window.confirm(
            `${name}에서 로그아웃할까요?\n\n저장된 로그인 정보를 지웁니다. 터미널의 claude도 같은 로그인 정보를 쓰므로 거기서도 로그아웃됩니다. 다시 쓰려면 [로그인]을 누르세요.`
        );
        if (!ok) return;
        setBusyFor(name, "logout");
        setRowError(name, null);
        forgetMcpLogin(name);
        try {
            const r = await window.electronAPI.mcpLogout(tabId, name);
            // strict가 꺼져 있어 !r.ok로는 좁혀지지 않는다
            if (r.ok === false) setRowError(name, {error: r.error, detail: r.detail});
        } finally {
            setBusyFor(name, null);
        }
    };

    if (servers.length === 0) return null;
    const connected = servers.filter((m) => m.status === "connected").length;
    const anyLoggingIn = servers.some((m) => isLoggingIn(logins[m.name]));

    return (
        <span className={cx("mcpWrap")}>
            <button
                className={cx("sessionStat", "mcpStat", {
                    sessionStatWarn: servers.some((m) => m.status === "needs-auth" || m.status === "pending"),
                    sessionStatDanger: servers.some((m) => m.status === "failed"),
                })}
                onClick={() => setOpen((v) => !v)}
                title={anyLoggingIn ? "MCP 서버 로그인 중 — 브라우저에서 허용하세요" : "MCP 서버 상태"}
            >
                <FontAwesomeIcon icon={anyLoggingIn ? faCircleNotch : faPlug} spin={anyLoggingIn} />
                MCP {connected}/{servers.length}
            </button>
            {open && (
                <>
                    <div className={cx("mcpBackdrop")} onClick={() => setOpen(false)} />
                    <div className={cx("mcpPopover")} role="dialog" aria-label="MCP 서버">
                        <div className={cx("mcpPopoverHeader")}>
                            MCP 서버
                            <button className={cx("mcpRefresh")} onClick={refresh} disabled={refreshing} title="다시 확인">
                                <FontAwesomeIcon icon={faRotateRight} spin={refreshing} />
                            </button>
                        </div>
                        {servers.map((m) => (
                            <McpRow
                                key={m.name}
                                tabId={tabId}
                                server={m}
                                login={logins[m.name]}
                                busy={busy[m.name]}
                                rowError={rowErrors[m.name]}
                                onReconnect={() => void reconnect(m.name)}
                                onLogout={() => void logout(m.name)}
                            />
                        ))}
                    </div>
                </>
            )}
        </span>
    );
}

function McpRow({
    tabId,
    server: m,
    login,
    busy,
    rowError,
    onReconnect,
    onLogout,
}: {
    tabId: string;
    server: McpServer;
    login: McpLoginState | undefined;
    busy: "reconnect" | "logout" | undefined;
    rowError: RowError | undefined;
    onReconnect: () => void;
    onLogout: () => void;
}) {
    const loggingIn = isLoggingIn(login);
    const needsAuth = m.status === "needs-auth";
    const claudeAi = m.transport === "claudeai-proxy";
    // 연결됐으면 끝난 로그인 표시는 보이지 않는다 (곧 지운다)
    const shown = login && (loggingIn || m.status !== "connected") ? login : undefined;

    let action = null;
    if (loggingIn) {
        action = (
            <button className={cx("mcpAction")} onClick={() => cancelMcpLogin(m.name)} title="로그인을 그만둡니다">
                취소
            </button>
        );
    } else if (shown?.phase === "done") {
        // 로그인했고 이 폴더의 목록을 다시 받는 중 — 곧 "연결됨"이 된다
    } else if (needsAuth && shown?.phase === "claudeai") {
        action = (
            <button className={cx("mcpAction")} onClick={onReconnect} disabled={!!busy} title="claude.ai에서 연결했는지 다시 확인합니다">
                {busy ? <FontAwesomeIcon icon={faCircleNotch} spin /> : "다시 확인"}
            </button>
        );
    } else if (needsAuth && !(shown?.phase === "error" && shown.unavailable)) {
        // 앱에서는 안 되는 버전(unavailable)이면 버튼 대신 터미널 안내만 — ↻로 다시 확인하면 버튼이 돌아온다
        action = (
            <button
                className={cx("mcpAction", "mcpActionPrimary")}
                onClick={() => void loginMcp(tabId, m.name)}
                title={
                    claudeAi
                        ? "claude.ai의 커넥터 설정을 브라우저로 엽니다 — 거기서 연결을 마치세요"
                        : "브라우저에서 이 서버에 로그인합니다 — 허용하면 바로 연결됩니다"
                }
            >
                {shown?.phase === "error" ? "다시 시도" : "로그인"}
            </button>
        );
    } else if (m.status === "failed") {
        action = (
            <button className={cx("mcpAction")} onClick={onReconnect} disabled={!!busy} title="이 서버에 다시 연결해 봅니다">
                {busy ? <FontAwesomeIcon icon={faCircleNotch} spin /> : "다시 연결"}
            </button>
        );
    } else if (m.status === "connected" && LOGOUT_TRANSPORTS.has(m.transport)) {
        action = (
            <button
                className={cx("mcpAction", "mcpActionQuiet")}
                onClick={onLogout}
                disabled={!!busy}
                title="저장된 로그인 정보를 지웁니다 (터미널의 claude에서도 로그아웃됩니다)"
            >
                {busy ? <FontAwesomeIcon icon={faCircleNotch} spin /> : "로그아웃"}
            </button>
        );
    }

    return (
        <div className={cx("mcpRow")}>
            <span className={cx("mcpDot", `mcpDot-${m.status}`)} />
            <span className={cx("mcpName")}>{m.name}</span>
            {action}
            <span className={cx("mcpMeta")}>
                {MCP_STATUS_LABELS[m.status] ?? m.status}
                {m.status === "connected" && ` · 도구 ${m.toolCount}`}
                {m.scope && ` · ${m.scope}`}
            </span>
            {m.error && <span className={cx("mcpError")}>{m.error}</span>}
            {shown?.phase === "starting" && (
                <span className={cx("mcpProgress")}>
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    로그인 준비 중…
                </span>
            )}
            {shown?.phase === "waiting" && (
                <span className={cx("mcpProgress")}>
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    브라우저에서 허용을 기다리는 중…
                </span>
            )}
            {shown?.phase === "done" && (
                <span className={cx("mcpProgress")}>
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    로그인했습니다 · 연결을 확인하는 중…
                </span>
            )}
            {shown?.phase === "claudeai" && needsAuth && (
                <span className={cx("mcpHint")}>claude.ai의 커넥터 설정에서 연결을 마친 뒤 [다시 확인]을 누르세요.</span>
            )}
            {shown?.phase === "error" &&
                (shown.unavailable ? (
                    <span className={cx("mcpHint")} title={shown.detail}>
                        {shown.error}
                    </span>
                ) : (
                    <span className={cx("mcpError")} title={shown.detail}>
                        {shown.error}
                    </span>
                ))}
            {rowError && (
                <span className={cx("mcpError")} title={rowError.detail}>
                    {rowError.error}
                </span>
            )}
            {m.status === "disabled" && <span className={cx("mcpHint")}>터미널에서 claude를 실행해 /mcp로 켤 수 있습니다.</span>}
        </div>
    );
}
