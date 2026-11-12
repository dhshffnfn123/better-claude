import {useMemo, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faCircleQuestion} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";

const cx = classNames.bind(styles);

interface Props {
    questions: AskQuestion[];
    onAnswer: (answers: string[][]) => void;
    onSkip: () => void;
}

// Claude가 AskUserQuestion으로 물어본 선택지를 그린다.
// 답은 tool_result로 되돌아가므로 라벨 문자열을 그대로 넘긴다.
export function QuestionModal({questions, onAnswer, onSkip}: Props) {
    // 질문별 선택 라벨 목록
    const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
    // 질문별 직접 입력값
    const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));

    const toggle = (qi: number, label: string, multi: boolean) => {
        setPicked((prev) =>
            prev.map((cur, i) => {
                if (i !== qi) return cur;
                if (!multi) return cur.includes(label) ? [] : [label];
                return cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
            })
        );
    };

    // 직접 입력이 있으면 그것도 답에 포함한다 (도구 설명상 "Other"는 항상 허용됨)
    const answers = useMemo(
        () => picked.map((sel, i) => (custom[i].trim() ? [...sel, custom[i].trim()] : sel)),
        [picked, custom]
    );
    const canSend = answers.some((a) => a.length > 0);

    return (
        <>
            <div className={cx("modalOverlay")} />
            <div className={cx("modal", "modalWide", "questionModal")}>
                <div className={cx("modalIcon")}>
                    <FontAwesomeIcon icon={faCircleQuestion} />
                </div>
                <h3 className={cx("modalTitle")}>Claude가 물어봅니다</h3>

                <div className={cx("questionList")}>
                    {questions.map((q, qi) => (
                        <div key={qi} className={cx("questionBlock")}>
                            {q.header && <span className={cx("questionHeader")}>{q.header}</span>}
                            <p className={cx("questionText")}>{q.question}</p>
                            {q.multiSelect && (
                                <span className={cx("questionHint")}>여러 개 고를 수 있습니다</span>
                            )}
                            <div className={cx("optionList")}>
                                {q.options.map((opt) => {
                                    const on = picked[qi].includes(opt.label);
                                    return (
                                        <button
                                            key={opt.label}
                                            className={cx("optionItem", {optionItemActive: on})}
                                            onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                                        >
                                            <span className={cx("optionCheck")}>
                                                {on && <FontAwesomeIcon icon={faCheck} />}
                                            </span>
                                            <span className={cx("optionBody")}>
                                                <span className={cx("optionLabel")}>{opt.label}</span>
                                                {opt.description && (
                                                    <span className={cx("optionDesc")}>
                                                        {opt.description}
                                                    </span>
                                                )}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            {/* 여러 줄로 답할 수 있게 textarea. Enter는 줄바꿈이다. */}
                            <textarea
                                className={cx("questionCustom")}
                                placeholder="직접 입력 (선택) · 여러 줄로 쓸 수 있습니다"
                                rows={2}
                                value={custom[qi]}
                                onChange={(e) => {
                                    // 내용에 맞춰 높이를 늘린다 (최대 높이는 CSS에서 제한)
                                    const el = e.target;
                                    el.style.height = "auto";
                                    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
                                    setCustom((prev) => prev.map((c, i) => (i === qi ? el.value : c)));
                                }}
                            />
                        </div>
                    ))}
                </div>

                <div className={cx("modalActions")}>
                    <button className={cx("modalBtn", "deny")} onClick={onSkip}>
                        건너뛰기
                    </button>
                    <button
                        className={cx("modalBtn", "allow")}
                        onClick={() => onAnswer(answers)}
                        disabled={!canSend}
                    >
                        답변 보내기
                    </button>
                </div>
            </div>
        </>
    );
}
