import classNames from "classnames/bind";
import styles from "./extensions.module.scss";
import type {ExtensionsTabProps} from "../../../extensions-open";

const cx = classNames.bind(styles);

// 플러그인 탭 — 설치됨·찾아보기 (다음 커밋에서 채운다)
export function PluginsTab({focus}: ExtensionsTabProps) {
    return <div className={cx("extSoon")}>플러그인 목록은 준비 중입니다{focus ? ` (${focus})` : ""}.</div>;
}
