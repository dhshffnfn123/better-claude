import {type ComponentType, useEffect, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import type {IconDefinition} from "@fortawesome/fontawesome-svg-core";
import {faBook, faCoins, faFolder, faPuzzlePiece, faTowerBroadcast, faXmark} from "@fortawesome/free-solid-svg-icons";
import shared from "../chat.page.module.scss";
import styles from "./extensions.module.scss";
import {MiddleName} from "../MiddleName";
import {
    type ExtensionsRequest,
    type ExtensionsTab,
    type ExtensionsTabProps,
    rememberExtensionsTab,
} from "../../../extensions-open";
import {type ExtensionsHost, ExtensionsHostContext} from "./extensions-host";
import {PluginsTab} from "./PluginsTab";
import {SkillsTab} from "./SkillsTab";
import {HooksTab} from "./HooksTab";
import {CostTab} from "./CostTab";

const cx = classNames.bind(styles);
const sx = classNames.bind(shared);

// 확장 창 — 사이드바 "확장"(또는 openExtensions)으로 연다. 사용 가이드처럼 탭 화면 위에 덮어 열 뿐이라 대화·응답은 그대로 이어진다.
// 왼쪽 탭 목록, 오른쪽 그 탭의 본문(extensions/*Tab.tsx). 머리줄의 폴더 = 보고 있는 탭의 작업 폴더 — 폴더마다 다른 것(프로젝트
// 스킬·훅, 이 레포 범위 플러그인, 대화 시작 비용)은 이 폴더 기준이다. 비유는 소유자의 정리 글에서: CLAUDE.md = 포스트잇,
// 스킬 = 서랍 속 매뉴얼, 훅 = 자동 센서, MCP = 전화선, 플러그인 = 그것들을 묶은 키트.
const TABS: {id: ExtensionsTab; label: string; hint: string; icon: IconDefinition; body: ComponentType<ExtensionsTabProps>}[] = [
    {id: "plugins", label: "플러그인", hint: "스킬·훅·MCP를 묶은 키트", icon: faPuzzlePiece, body: PluginsTab},
    {id: "skills", label: "스킬", hint: "필요할 때 꺼내 보는 매뉴얼", icon: faBook, body: SkillsTab},
    {id: "hooks", label: "훅", hint: "정해진 순간 저절로 도는 센서", icon: faTowerBroadcast, body: HooksTab},
    {id: "cost", label: "대화 시작 비용", hint: "새 대화가 처음부터 쓰는 토큰", icon: faCoins, body: CostTab},
];

interface Props {
    tabId: string; // 보고 있는 대화 탭
    cwd: string; // 그 탭의 작업 폴더
    request: ExtensionsRequest;
    host: ExtensionsHost;
}

export function ExtensionsDialog({tabId, cwd, request, host}: Props) {
    // 지금 보이는 탭과 찾아갈 것 — 새 요청(openExtensions)이 오면 그리로, 왼쪽 목록을 누르면 그 탭 첫 화면으로
    const [view, setView] = useState({tab: request.tab, focus: request.focus, seq: request.seq});
    useEffect(() => setView({tab: request.tab, focus: request.focus, seq: request.seq}), [request]);
    useEffect(() => rememberExtensionsTab(view.tab), [view.tab]);

    // Esc로 닫는다. 창 안의 작은 확인 창·검색 칸은 먼저 받아(capture 단계) preventDefault한다 — 그때는 닫지 않는다.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented) host.close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [host]);

    const current = TABS.find((t) => t.id === view.tab) ?? TABS[0];
    const Body = current.body;

    return (
        <ExtensionsHostContext.Provider value={host}>
            <div className={sx("modalOverlay")} onClick={host.close} />
            <div className={cx("extDialog")} role="dialog" aria-label="확장">
                <div className={sx("guideHeader")}>
                    <span className={sx("guideTitle")}>확장</span>
                    <span
                        className={cx("extFolder")}
                        data-tooltip="스킬·훅·대화 시작 비용과 이 레포 범위 플러그인은 이 폴더 기준입니다 (보고 있는 탭의 작업 폴더)"
                        data-tooltip-dir="down"
                    >
                        <FontAwesomeIcon icon={faFolder} className={cx("extFolderIcon")} />
                        <span className={cx("extFolderPath")}>
                            <MiddleName name={cwd || "…"} />
                        </span>
                    </span>
                    <button className={sx("guideClose")} onClick={host.close} title="닫기 (Esc)" aria-label="닫기">
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                </div>
                <div className={cx("extMain")}>
                    <nav className={cx("extNav")} aria-label="확장 종류">
                        {TABS.map((t) => (
                            <button
                                key={t.id}
                                className={cx("extNavItem", {extNavActive: t.id === view.tab})}
                                aria-current={t.id === view.tab ? "page" : undefined}
                                title={`${t.label} — ${t.hint}`}
                                onClick={() => setView((v) => (v.tab === t.id ? v : {tab: t.id, focus: undefined, seq: v.seq}))}
                            >
                                <FontAwesomeIcon icon={t.icon} className={cx("extNavIcon")} />
                                <span className={cx("extNavText")}>
                                    <span className={cx("extNavLabel")}>{t.label}</span>
                                    <span className={cx("extNavHint")}>{t.hint}</span>
                                </span>
                            </button>
                        ))}
                        <p className={cx("extNavNote")}>여기서 바꾼 설정은 터미널의 claude와 함께 씁니다.</p>
                    </nav>
                    <div className={cx("extBody")}>
                        <Body key={`${view.tab}:${view.seq}:${tabId}:${cwd}`} tabId={tabId} cwd={cwd} focus={view.focus} />
                    </div>
                </div>
            </div>
        </ExtensionsHostContext.Provider>
    );
}
