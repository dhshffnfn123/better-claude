// Claude가 물은 질문(AskUserQuestion)과 내가 한 답 — 답변 속 질문 카드와 진행 패널에 쓴다.
//
// 답은 따로 저장하지 않고, main이 만들어 Claude에게 보낸 tool_result 글을 다시 읽는다
// (src/main.ts formatQuestionAnswers). 그래서 실시간 응답과 불러온 대화가 같은 결과를 보여 준다.
//   The user answered:
//   - 이름: 고른 선택지, 고른 선택지2
//     Other: 직접 쓴 첫 줄          ← 직접 입력은 "Other: " 줄로 따로 (여러 줄은 두 칸 들여 쓴다)
//     직접 쓴 둘째 줄
//   - 이름2: (skipped)
// 예전 형식은 직접 입력을 고른 선택지 뒤에 ", "로 이어 붙였다 — 선택지 이름과 맞춰 보며 나눈다.
// 프로토콜상 답을 돌려줄 자리가 deny의 message뿐이라 결과는 is_error로 온다 — 오류가 아니다.

export const QUESTION_TOOL = "AskUserQuestion";
const ANSWERED_PREFIX = "The user answered:";
const OTHER_PREFIX = "Other: ";
// 중지·창 닫기 등으로 답하지 못하고 끝났을 때 main이 돌려주는 글
const UNANSWERED_TEXT = "The user did not answer the questions.";

export interface AskedQuestion {
    header: string;
    question: string;
    multiSelect: boolean;
    options: string[]; // 선택지 이름 — 답에서 고른 것과 직접 입력을 가르는 데 쓴다
}

// 한 질문의 답: 고른 선택지들과 직접 입력(없으면 null)
export interface ParsedAnswer {
    picks: string[];
    custom: string | null;
}

export type QuestionOutcome =
    | {kind: "waiting"}
    | {kind: "answered"; answers: (ParsedAnswer | null)[]} // null = 건너뜀
    | {kind: "unanswered"}
    | {kind: "other"; text: string};

// 도구 입력에서 질문 목록을 꺼낸다 (모양이 틀린 항목은 건너뛴다)
export function questionsOf(input: unknown): AskedQuestion[] {
    const raw = (input as {questions?: unknown} | null)?.questions;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((q) => (q ?? {}) as Record<string, unknown>)
        .filter((q) => typeof q.question === "string")
        .map((q) => ({
            header: typeof q.header === "string" ? q.header : "",
            question: q.question as string,
            multiSelect: q.multiSelect === true,
            options: Array.isArray(q.options)
                ? q.options
                      .map((o) => ((o ?? {}) as {label?: unknown}).label)
                      .filter((l): l is string => typeof l === "string" && l.length > 0)
                : [],
        }));
}

export function isAnswered(resultText: string | undefined): boolean {
    return !!resultText && resultText.startsWith(ANSWERED_PREFIX);
}

// 한 질문의 답 글을 고른 선택지와 직접 입력으로 나눈다.
export function splitAnswer(answer: string, options: string[]): ParsedAnswer {
    let picksPart = answer;
    let custom: string | null = null;
    if (answer.startsWith(OTHER_PREFIX)) {
        picksPart = "";
        custom = answer.slice(OTHER_PREFIX.length);
    } else {
        const at = answer.indexOf("\n" + OTHER_PREFIX);
        if (at >= 0) {
            picksPart = answer.slice(0, at);
            custom = answer.slice(at + 1 + OTHER_PREFIX.length);
        }
    }
    // 고른 선택지 = 아는 이름을 앞에서부터 ", "로 이은 것. 이름 안에 ", "가 있어도 되게 긴 이름부터 맞춘다.
    const byLength = [...options].sort((a, b) => b.length - a.length);
    const picks: string[] = [];
    let rest = picksPart;
    while (rest) {
        const hit = byLength.find((o) => rest === o || rest.startsWith(o + ", "));
        if (!hit) break;
        picks.push(hit);
        rest = rest.slice(hit.length);
        if (rest.startsWith(", ")) rest = rest.slice(2);
    }
    // 남은 것 = 예전 형식에서 끝에 붙던 직접 입력 (또는 선택지에 없는 답)
    if (rest) custom = custom ? `${rest}\n${custom}` : rest;
    return {picks, custom};
}

// "The user answered:" 글을 질문 순서대로 나눈다. 질문마다 "- " 줄이 하나씩 순서대로 온다.
function parseAnswers(text: string, questions: AskedQuestion[]): (ParsedAnswer | null)[] {
    const items: string[] = [];
    for (const line of text.slice(ANSWERED_PREFIX.length).split("\n")) {
        if (line.startsWith("- ")) items.push(line.slice(2));
        // 이어지는 줄: 두 칸 들여 쓴 줄(지금 형식), 또는 들여쓰기 없이 이어진 줄(예전 형식)
        else if (items.length > 0 && line.length > 0) items[items.length - 1] += "\n" + (line.startsWith("  ") ? line.slice(2) : line);
    }
    return questions.map((q, i) => {
        const item = items[i];
        if (item == null) return null;
        const label = q.header || q.question;
        let answer: string;
        if (item.startsWith(`${label}: `)) {
            answer = item.slice(label.length + 2);
        } else {
            const colon = item.indexOf(": ");
            answer = colon >= 0 ? item.slice(colon + 2) : item;
        }
        return answer === "(skipped)" ? null : splitAnswer(answer, q.options);
    });
}

export function questionOutcome(status: "running" | "done" | "error", resultText: string | undefined, questions: AskedQuestion[]): QuestionOutcome {
    if (status === "running" || resultText == null) return {kind: "waiting"};
    if (isAnswered(resultText)) return {kind: "answered", answers: parseAnswers(resultText, questions)};
    if (resultText.trim() === UNANSWERED_TEXT) return {kind: "unanswered"};
    return {kind: "other", text: resultText};
}
