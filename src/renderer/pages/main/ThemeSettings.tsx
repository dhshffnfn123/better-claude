import {useEffect, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faCircleHalfStroke, faMoon, faSun} from "@fortawesome/free-solid-svg-icons";
import type {IconDefinition} from "@fortawesome/fontawesome-svg-core";
import styles from "./chat.page.module.scss";

const cx = classNames.bind(styles);

const OPTIONS: {value: ThemeSource; label: string; icon: IconDefinition}[] = [
    {value: "system", label: "시스템 설정 따름", icon: faCircleHalfStroke},
    {value: "light", label: "라이트", icon: faSun},
    {value: "dark", label: "다크", icon: faMoon},
];

const DARK_QUERY = "(prefers-color-scheme: dark)";

// 헤더의 화면 테마 버튼. 고르면 main이 nativeTheme.themeSource를 바꾸고 저장한다 —
// 색은 styles/theme.css가 prefers-color-scheme으로 따라 바뀐다.
export function ThemeSettings() {
    const [source, setSource] = useState<ThemeSource>("system");
    const [open, setOpen] = useState(false);
    // 지금 실제로 다크인지 (시스템 따름일 때 안내에 쓴다)
    const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

    useEffect(() => {
        void window.electronAPI.getTheme().then(setSource);
        const mq = window.matchMedia(DARK_QUERY);
        const onChange = () => setDark(mq.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    const choose = (next: ThemeSource) => {
        setSource(next);
        void window.electronAPI.setTheme(next).then(setSource);
    };

    const current = OPTIONS.find((o) => o.value === source) ?? OPTIONS[0];
    const tooltip = `화면 테마: ${current.label}${source === "system" ? ` (지금 ${dark ? "다크" : "라이트"})` : ""}`;

    return (
        <span className={cx("notifyWrap")}>
            <button
                className={cx("permissionToggle")}
                onClick={() => setOpen((v) => !v)}
                // 열려 있을 때는 말풍선이 창을 가린다
                data-tooltip={open ? undefined : tooltip}
                data-tooltip-dir="down"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label="화면 테마"
            >
                <FontAwesomeIcon icon={current.icon} />
            </button>
            {open && (
                <>
                    <div className={cx("mcpBackdrop")} onClick={() => setOpen(false)} />
                    <div className={cx("notifyPopover", "themePopover")} role="dialog" aria-label="화면 테마">
                        <div className={cx("notifyTitle")}>화면 테마</div>
                        <div role="radiogroup" className={cx("themeOptions")}>
                            {OPTIONS.map((o) => (
                                <button
                                    key={o.value}
                                    role="radio"
                                    aria-checked={source === o.value}
                                    className={cx("themeOption", {themeOptionActive: source === o.value})}
                                    onClick={() => choose(o.value)}
                                >
                                    <FontAwesomeIcon icon={o.icon} className={cx("themeOptionIcon")} />
                                    <span className={cx("themeOptionText")}>
                                        <span className={cx("notifyLabel")}>{o.label}</span>
                                        {o.value === "system" && (
                                            <span className={cx("notifyHint")}>
                                                macOS 화면 모드를 따릅니다
                                                {source === "system" && ` · 지금 ${dark ? "다크" : "라이트"}`}
                                            </span>
                                        )}
                                    </span>
                                    {source === o.value && (
                                        <FontAwesomeIcon icon={faCheck} className={cx("themeOptionCheck")} />
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </span>
    );
}
