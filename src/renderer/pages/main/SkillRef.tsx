import {useContext} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faBook, faChevronRight} from "@fortawesome/free-solid-svg-icons";
import styles from "./SkillRef.module.scss";
import {TabIdContext} from "../../tab-context";
import {openExtensions} from "../../extensions-open";
import {leadingSlashName, useSkillNames} from "../../skill-names";
import {MiddleName} from "./MiddleName";

const cx = classNames.bind(styles);

// 내 메시지가 이 폴더의 스킬(·사용자 명령)을 /이름으로 부른 것이면 그 위에 "스킬 · 이름 보기" — 누르면 확장 창의 스킬 탭에서
// 그 스킬을 연다. Claude에게 가는 글은 그대로다(표시만 더한다). 지금 보낸 메시지와 다시 연 대화가 같다: 기록의 명령 항목도
// "/이름 인자" 글로 온다(sessionToMessages의 describeCommandEntry).
export function SkillChip({content}: {content: string}) {
    const name = leadingSlashName(content);
    if (!name) return null;
    return <SkillChipFor name={name} />;
}

// 이름을 아는 메시지만 명령 목록을 구독한다 (메시지마다 구독하지 않게)
function SkillChipFor({name}: {name: string}) {
    const tabId = useContext(TabIdContext);
    const names = useSkillNames(tabId);
    if (!names?.has(name)) return null;
    return (
        <div className={cx("skillChipRow")}>
            <button
                className={cx("skillChip")}
                onClick={() => openExtensions("skills", name)}
                title="확장 창의 스킬 탭에서 이 스킬을 봅니다"
            >
                <FontAwesomeIcon icon={faBook} className={cx("skillChipIcon")} />
                <span className={cx("skillChipLabel")}>스킬</span>
                <span className={cx("skillChipName")}>
                    <MiddleName name={name} />
                </span>
                <span className={cx("skillChipOpen")}>
                    보기 <FontAwesomeIcon icon={faChevronRight} />
                </span>
            </button>
        </div>
    );
}
