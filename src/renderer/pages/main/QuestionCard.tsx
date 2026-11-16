import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faCircleNotch, faCircleQuestion} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {ToolActivity} from "../../hooks/useClaudeChat";
import {questionOutcome, questionsOf} from "../../question-answers";

const cx = classNames.bind(styles);

// 답변 속 Claude의 질문(AskUserQuestion) — 질문마다 무엇을 물었고 내가 뭐라고 답했는지 보여 준다.
// 예전에는 ⚠ 표시와 함께 도구 입력(JSON)만 한 줄로 보였다(답이 deny 결과로 돌아가 오류처럼 보였다).
export function QuestionCard({tool}: {tool: ToolActivity}) {
    const questions = questionsOf(tool.input);
    const outcome = questionOutcome(tool.status, tool.resultPreview, questions);
    const status =
        outcome.kind === "waiting" ? "답을 기다리는 중" : outcome.kind === "unanswered" ? "답하지 않음" : outcome.kind === "other" ? "답하지 못함" : "";

    return (
        <div className={cx("questionCard")}>
            <div className={cx("questionCardHead")}>
                <FontAwesomeIcon icon={faCircleQuestion} className={cx("questionCardIcon")} />
                Claude의 질문
                {status && (
                    <span className={cx("questionCardStatus")}>
                        {outcome.kind === "waiting" && <FontAwesomeIcon icon={faCircleNotch} spin />}
                        {status}
                    </span>
                )}
            </div>
            {questions.map((q, i) => {
                const answer = outcome.kind === "answered" ? outcome.answers[i] : undefined;
                return (
                    <div key={i} className={cx("questionCardItem")}>
                        <div className={cx("questionCardText")}>
                            {q.header && <span className={cx("questionCardChip")}>{q.header}</span>}
                            {q.question}
                        </div>
                        {outcome.kind === "answered" && (
                            <div className={cx("questionAnswer", {questionAnswerSkipped: answer == null})}>
                                <span className={cx("questionAnswerLabel")}>내 답</span>
                                {answer == null ? (
                                    <span className={cx("questionAnswerText")}>건너뜀</span>
                                ) : (
                                    // 고른 선택지는 하나씩 칩으로, 직접 입력은 따로 — 한 줄로 이어 붙이면 읽기 어렵다
                                    <div className={cx("questionAnswerBody")}>
                                        {answer.picks.length > 0 && (
                                            <div className={cx("questionPicks")}>
                                                {answer.picks.map((pick) => (
                                                    <span key={pick} className={cx("questionPick")}>
                                                        <FontAwesomeIcon icon={faCheck} className={cx("questionPickIcon")} />
                                                        {pick}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        {answer.custom && (
                                            <div className={cx("questionCustomAnswer")}>
                                                <span className={cx("questionCustomLabel")}>직접 입력</span>
                                                <span className={cx("questionCustomText")}>{answer.custom}</span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
            {outcome.kind === "other" && <div className={cx("questionOther")}>{outcome.text}</div>}
        </div>
    );
}
