import classNames from "classnames/bind";
import styles from "./chat.page.module.scss";

const cx = classNames.bind(styles);

// 길면 가운데를 …로 줄이는 이름 — 앞쪽(폴더, 이름 앞부분)만 줄어들고 끝(파일 이름)은 늘 보인다.
// CSS 끝 말줄임(text-overflow)만 쓰면 정작 중요한 파일 이름이 가려진다. 경로면 "/파일 이름"을 통째로 남기고,
// 파일 이름이 길거나 경로가 아니면 끝 12글자를 남긴다. 너비는 감싼 쪽이 정한다(이 상자는 그 너비를 꽉 채운다).
const TAIL_MAX = 24;
const TAIL_SHORT = 12;

export function MiddleName({name}: {name: string}) {
    const slash = name.lastIndexOf("/");
    const file = name.slice(slash + 1);
    const keep = slash > 0 && file.length + 1 <= TAIL_MAX ? file.length + 1 : TAIL_SHORT;
    if (name.length <= keep + 3) {
        return (
            <span className={cx("midName")}>
                <span className={cx("midNameHead")}>{name}</span>
            </span>
        );
    }
    return (
        <span className={cx("midName")}>
            <span className={cx("midNameHead")}>{name.slice(0, -keep)}</span>
            <span className={cx("midNameTail")}>{name.slice(-keep)}</span>
        </span>
    );
}
