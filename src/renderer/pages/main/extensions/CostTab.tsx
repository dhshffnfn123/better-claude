import classNames from "classnames/bind";
import styles from "./extensions.module.scss";
import type {ExtensionsTabProps} from "../../../extensions-open";

const cx = classNames.bind(styles);

// 대화 시작 비용 탭 — 새 대화가 처음부터 쓰는 토큰과 그 내역 (다음 커밋에서 채운다)
export function CostTab({cwd}: ExtensionsTabProps) {
    return <div className={cx("extSoon")}>대화 시작 비용은 준비 중입니다 ({cwd}).</div>;
}
