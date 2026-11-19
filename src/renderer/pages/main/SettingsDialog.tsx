import {useEffect} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faXmark} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import {Switch} from "./NotificationSettings";
import {type JumpMode, useJumpMode} from "../../jump-setting";
import {useMemoryToastEnabled} from "../../memory-toast-setting";
import {useFigmaPlan} from "../../figma-plan-setting";
import {useFigmaFeatures} from "../../figma-setting";
import {FIGMA_PLANS, type FigmaPlan} from "../../../shared/figma";

const cx = classNames.bind(styles);

// 설정 — 사이드바 "설정"(사용 가이드 밑)으로 연다. 탭 화면 위에 덮어 열 뿐이라 대화·응답은 그대로 이어진다.
// 알림·테마처럼 헤더에 버튼이 따로 있는 것은 그대로 두고, 자리가 없는 일반 설정을 여기에 모은다.

const JUMP_CHOICES: {value: JumpMode; title: string; desc: string}[] = [
    {
        value: "reading",
        title: "보고 있는 답변",
        desc: "화면 맨 위에 걸친 답변의 처음으로 갑니다. 위로 올려 예전 답변을 읽는 중이면 그 답변의 처음으로 갑니다.",
    },
    {
        value: "last",
        title: "마지막 답변",
        desc: "어디를 보고 있든 가장 최근 답변의 처음으로 갑니다. 그 첫 줄이 화면 밖에 있을 때 버튼이 나옵니다.",
    },
];

export function SettingsDialog({onClose}: {onClose: () => void}) {
    const [jump, setJump] = useJumpMode();
    const [memoryToast, setMemoryToast] = useMemoryToastEnabled();
    const [figmaPlan, setFigmaPlan] = useFigmaPlan();
    const [figmaOn, setFigmaOn] = useFigmaFeatures();

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !e.isComposing) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <>
            <div className={cx("modalOverlay")} onClick={onClose} />
            <div className={cx("settingsDialog")} role="dialog" aria-label="설정">
                <div className={cx("guideHeader")}>
                    <span className={cx("guideTitle")}>설정</span>
                    <span className={cx("settingsSpacer")} />
                    <button className={cx("guideClose")} onClick={onClose} title="닫기 (Esc)" aria-label="닫기">
                        <FontAwesomeIcon icon={faXmark} />
                    </button>
                </div>
                <div className={cx("settingsBody")}>
                    <section className={cx("settingsSection")}>
                        <h3 className={cx("settingsSectionTitle")}>대화 화면</h3>
                        <div className={cx("settingsLabel")}>"답변 처음으로" 버튼 기준</div>
                        <p className={cx("settingsHint")}>
                            긴 답변을 읽을 때 대화 오른쪽 위에 나오는 버튼이 어느 답변의 처음으로 갈지 정합니다.
                        </p>
                        <div className={cx("settingsChoices")} role="radiogroup" aria-label="답변 처음으로 버튼 기준">
                            {JUMP_CHOICES.map((c) => (
                                <button
                                    key={c.value}
                                    className={cx("settingsChoice", {settingsChoiceOn: jump === c.value})}
                                    role="radio"
                                    aria-checked={jump === c.value}
                                    onClick={() => setJump(c.value)}
                                >
                                    <span className={cx("settingsRadio")} />
                                    <span className={cx("settingsChoiceText")}>
                                        <span className={cx("settingsChoiceTitle")}>
                                            {c.title}
                                            {c.value === "reading" && <span className={cx("settingsDefault")}>기본</span>}
                                        </span>
                                        <span className={cx("settingsChoiceDesc")}>{c.desc}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className={cx("settingsSwitchRow")}>
                            <div className={cx("settingsSwitchText")}>
                                <div className={cx("settingsLabel")}>기억 알림</div>
                                <p className={cx("settingsHint")}>Claude가 무언가를 기억해 두면 창 가운데에 그 내용을 잠깐 띄웁니다.</p>
                            </div>
                            <Switch checked={memoryToast} onChange={setMemoryToast} label="기억 알림" />
                        </div>
                    </section>
                    <section className={cx("settingsSection")}>
                        <h3 className={cx("settingsSectionTitle")}>Figma</h3>
                        <div className={cx("settingsSwitchRow")}>
                            <div className={cx("settingsSwitchText")}>
                                <div className={cx("settingsLabel")}>Figma 기능</div>
                                <p className={cx("settingsHint")}>
                                    끄면 앱의 Figma 화면(도구 줄 꾸미기·링크 카드·호출 수·화면 대조)만 숨깁니다 — Figma 플러그인·MCP는 그대로
                                    동작합니다.
                                </p>
                            </div>
                            <Switch checked={figmaOn} onChange={setFigmaOn} label="Figma 기능" />
                        </div>
                        {figmaOn && (
                            <>
                                <div className={cx("settingsLabel", "settingsLabelGap")}>요금제 · 좌석 (호출 한도 표시 기준)</div>
                                <p className={cx("settingsHint")}>
                                    Figma에서 읽어 오는 도구 호출은 요금제·좌석마다 횟수가 정해져 있습니다. 작업 폴더 줄의 MCP 창에서 figma 줄
                                    밑에 이 기준으로 얼마나 썼는지 보여 줍니다. 앱은 계정의 요금제를 알 수 없어 여기서 고릅니다.
                                </p>
                                <div className={cx("settingsChoices")} role="radiogroup" aria-label="Figma 요금제와 좌석">
                                    {(Object.keys(FIGMA_PLANS) as FigmaPlan[]).map((id) => (
                                        <button
                                            key={id}
                                            className={cx("settingsChoice", {settingsChoiceOn: figmaPlan === id})}
                                            role="radio"
                                            aria-checked={figmaPlan === id}
                                            onClick={() => setFigmaPlan(id)}
                                        >
                                            <span className={cx("settingsRadio")} />
                                            <span className={cx("settingsChoiceText")}>
                                                <span className={cx("settingsChoiceTitle")}>
                                                    {FIGMA_PLANS[id].title}
                                                    {id === "pro" && <span className={cx("settingsDefault")}>기본</span>}
                                                </span>
                                                <span className={cx("settingsChoiceDesc")}>{FIGMA_PLANS[id].desc}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                <p className={cx("settingsHint", "settingsHintAfter")}>
                                    한도는 Figma 문서에 나온 숫자이고 Figma가 바꿀 수 있습니다. 쓰기 도구(파일 수정·새 파일 등)는 한도에서
                                    빠집니다.
                                </p>
                            </>
                        )}
                    </section>
                    <p className={cx("settingsNote")}>바꾸면 모든 탭에 바로 적용되고, 앱을 다시 켜도 그대로입니다.</p>
                </div>
            </div>
        </>
    );
}
