import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowUpRightFromSquare} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {FigmaLink} from "../../../shared/figma";
import {FIGMA_ACTIONS, type FigmaQuickAction, figmaCardMeta, figmaCardName} from "../../figma-links";
import {FigmaLogo} from "./FigmaLogo";
import {MiddleName} from "./MiddleName";

const cx = classNames.bind(styles);

// Figma 링크 한 장 — Figma 로고 + 파일 이름(주소 속 이름) + "디자인 · 프레임 12:34" + Figma에서 열기.
// note: 둘째 줄 끝에 덧붙일 말 (입력창: "붙인 링크에서 알아냄" — Figma에 묻지 않고 주소만 읽었다는 뜻)
export function FigmaLinkCard({link, note}: {link: FigmaLink; note?: string}) {
    return (
        // 주소는 "Figma에서 열기"의 title로만 — CSS 말풍선(data-tooltip)은 숨어 있어도 자리를 차지해, 오른쪽에 붙는 보낸
        // 메시지 카드에서 긴 주소가 대화 목록 밖으로 삐져 가로 스크롤이 생겼다
        <div className={cx("figmaCard")}>
            <span className={cx("figmaCardTile")}>
                <FigmaLogo />
            </span>
            <span className={cx("figmaCardText")}>
                <span className={cx("figmaCardName")}>
                    <MiddleName name={figmaCardName(link)} />
                </span>
                <span className={cx("figmaCardMeta")}>
                    {figmaCardMeta(link)}
                    {note ? ` · ${note}` : ""}
                </span>
            </span>
            {/* 웹 주소는 새 창 요청으로 — main(link-guard)이 기본 브라우저(Figma 앱이 있으면 앱)로 연다 */}
            <a className={cx("figmaCardOpen")} href={link.url} target="_blank" rel="noreferrer noopener" title={link.url}>
                Figma에서 열기 <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
            </a>
        </div>
    );
}

// 빠른 작업 칩 — 누르면 준비된 요청문으로 입력창을 채운다(보내지 않는다)
export function FigmaQuickActions({onPick}: {onPick: (action: FigmaQuickAction) => void}) {
    return (
        <div className={cx("figmaActions")}>
            <span className={cx("figmaActionsLabel")}>이 링크로</span>
            {FIGMA_ACTIONS.map((a) => (
                <button key={a.id} className={cx("figmaAction")} onClick={() => onPick(a)} title={a.prompt.join("\n")}>
                    {a.label}
                </button>
            ))}
        </div>
    );
}
