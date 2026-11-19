import type {CSSProperties} from "react";
import {useEffect, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faBell, faPlay, faVolumeHigh, faVolumeLow, faVolumeXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {useNotificationSettings} from "../../hooks/useNotificationSound";
import {useSuggestionsEnabled} from "../../suggestion-setting";

const cx = classNames.bind(styles);

// 켜기/끄기 스위치 — 설정 창(SettingsDialog)·확장 창의 플러그인 켜기·끄기도 같이 쓴다
export function Switch({
    checked,
    onChange,
    label,
    disabled = false,
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    label: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            className={cx("switch", {switchOn: checked})}
            onClick={() => onChange(!checked)}
        >
            <span className={cx("switchKnob")} />
        </button>
    );
}

// 슬라이더를 놓거나 키보드로 옮긴 뒤 새 음량으로 한 번 들려준다
const VOLUME_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

// 헤더의 스피커 버튼: 알림음(켜기·음량)과 macOS 알림 설정
export function NotificationSettings() {
    const s = useNotificationSettings();
    const [suggestOn, setSuggestOn] = useSuggestionsEnabled();
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    const audible = s.soundEnabled && s.volume > 0;
    const icon = !audible ? faVolumeXmark : s.volume < 35 ? faVolumeLow : faVolumeHigh;
    const tooltip = `알림 설정 · 알림음 ${audible ? `${s.volume}%` : "꺼짐"} · macOS 알림 ${s.osEnabled ? "켜짐" : "꺼짐"}`;

    return (
        <span className={cx("notifyWrap")}>
            <button
                className={cx("permissionToggle", {active: audible})}
                onClick={() => setOpen((v) => !v)}
                // 열려 있을 때는 말풍선이 창을 가린다
                data-tooltip={open ? undefined : tooltip}
                data-tooltip-dir="down"
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                <FontAwesomeIcon icon={icon} />
            </button>
            {open && (
                <>
                    <div className={cx("mcpBackdrop")} onClick={() => setOpen(false)} />
                    <div className={cx("notifyPopover")} role="dialog" aria-label="알림 설정">
                        <div className={cx("notifyTitle")}>알림</div>

                        <div className={cx("notifyRow")}>
                            <div className={cx("notifyText")}>
                                <span className={cx("notifyLabel")}>알림음</span>
                                <span className={cx("notifyHint")}>
                                    응답이 끝날 때 울립니다. 앱을 보고 있지 않을 때 Claude가 허용이나 답을 기다리면
                                    다른 소리로 울립니다.
                                </span>
                            </div>
                            <Switch checked={s.soundEnabled} onChange={s.setSoundEnabled} label="알림음" />
                        </div>
                        <div className={cx("notifyVolume", {notifyDisabled: !s.soundEnabled})}>
                            <FontAwesomeIcon icon={faVolumeLow} className={cx("notifyVolumeIcon")} />
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={5}
                                value={s.volume}
                                disabled={!s.soundEnabled}
                                onChange={(e) => s.setVolume(Number(e.target.value))}
                                onPointerUp={s.preview}
                                onKeyUp={(e) => {
                                    if (VOLUME_KEYS.has(e.key)) s.preview();
                                }}
                                aria-label="알림음 음량"
                                className={cx("notifyRange")}
                                style={{"--fill": `${s.volume}%`} as CSSProperties}
                            />
                            <span className={cx("notifyVolumeValue")}>{s.volume}%</span>
                            <button
                                className={cx("notifyIconBtn")}
                                onClick={s.preview}
                                disabled={!s.soundEnabled}
                                title="들어 보기"
                                aria-label="들어 보기"
                            >
                                <FontAwesomeIcon icon={faPlay} />
                            </button>
                        </div>

                        <div className={cx("notifyDivider")} />

                        <div className={cx("notifyRow")}>
                            <div className={cx("notifyText")}>
                                <span className={cx("notifyLabel")}>macOS 알림</span>
                                <span className={cx("notifyHint")}>
                                    앱을 보고 있지 않을 때 응답 완료·허용 요청·질문을 알림 센터로 보냅니다. 알림을 누르면
                                    앱으로 돌아옵니다.
                                </span>
                            </div>
                            <Switch checked={s.osEnabled} onChange={s.setOsEnabled} label="macOS 알림" />
                        </div>
                        <button className={cx("notifyTestBtn")} onClick={s.testNotification} disabled={!s.osEnabled}>
                            <FontAwesomeIcon icon={faBell} /> 알림 보내 보기
                        </button>
                        <p className={cx("notifyFootnote")}>
                            알림이 뜨지 않으면 시스템 설정 → 알림에서 이 앱의 알림을 허용하세요.
                        </p>

                        <div className={cx("notifyDivider")} />

                        <div className={cx("notifyRow")}>
                            <div className={cx("notifyText")}>
                                <span className={cx("notifyLabel")}>다음 요청 추천</span>
                                <span className={cx("notifyHint")}>
                                    답변이 끝나면 Claude가 짐작한 다음 요청을 빈 입력창에 흐리게 보여 줍니다. Tab으로
                                    채웁니다. 다음 메시지부터 적용됩니다.
                                </span>
                            </div>
                            <Switch checked={suggestOn} onChange={setSuggestOn} label="다음 요청 추천" />
                        </div>
                    </div>
                </>
            )}
        </span>
    );
}
