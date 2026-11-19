import classNames from "classnames/bind";
import styles from "./extensions.module.scss";
import type {ExtensionsTabProps} from "../../../extensions-open";

const cx = classNames.bind(styles);

// 훅 탭 — 아직 준비 중. 다른 작업이 이 파일을 통째로 바꾼다.
export function HooksTab({focus}: ExtensionsTabProps) {
    return <div className={cx("extSoon")}>훅 목록은 준비 중입니다{focus ? ` (${focus})` : ""}.</div>;
}
