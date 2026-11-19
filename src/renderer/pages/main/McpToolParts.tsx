import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowUpRightFromSquare} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {McpToolDisplay} from "../../mcp-tool-display";

const cx = classNames.bind(styles);

// 도구 줄의 MCP 도구 이름 — 기본 "서버 · 도구", 꾸미기가 있으면 그 아이콘·이름 (예: Figma 로고 + "Figma · 화면 캡처").
// 원래 이름(mcp__…)은 마우스를 올리면 보인다.
export function McpToolName({display, rawName}: {display: McpToolDisplay; rawName: string}) {
    const Icon = display.Icon;
    return (
        <span className={cx("toolName", "mcpToolName")} title={rawName}>
            {Icon && <Icon className={cx("mcpToolIcon")} />}
            <span>{display.title}</span>
        </span>
    );
}

// 줄 오른쪽 끝의 열기 링크 ("Figma에서 열기 ↗" 등). 웹 주소는 새 창 요청으로 보내 main(link-guard)이 기본 브라우저로 연다.
// 줄을 누르면 펼치는 동작이 있어 링크 클릭은 위로 올리지 않는다.
export function McpToolLinks({display}: {display: McpToolDisplay}) {
    if (display.links.length === 0) return null;
    return (
        <span className={cx("mcpToolLinks")}>
            {display.links.map((l) => (
                <a
                    key={l.url}
                    className={cx("mcpToolLink")}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    title={l.url}
                >
                    {l.label} <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
                </a>
            ))}
        </span>
    );
}
