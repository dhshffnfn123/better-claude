// 셸 출력 → 터미널이 실제로 보여 주는 글.
// dev 서버 같은 명령은 색·굵기(ESC[2m … ESC[22m), 줄 지우기·커서 이동, 링크(OSC 8) 같은 터미널 제어 문자를
// 출력 파일에 그대로 쓴다. 그대로 보이면 "[2m7:30:01 PM[22m [vite] …"처럼 글자로 섞였다
// (입력창 위 작업 카드의 마지막 줄, 백그라운드 패널의 로그).

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // 창 제목·링크
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g; // 색·굵기, 커서 이동, 줄 지우기
const OTHER_ESC = /\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]/g; // 문자 집합 전환 등 두 글자짜리
const CUT_TAIL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/; // 쓰는 중이라 끝이 잘린 제어 문자
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // 남은 제어 문자(벨 …) — 탭·줄바꿈은 둔다
/* eslint-enable no-control-regex */

export function terminalText(text: string): string {
    const plain = text.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "").replace(CUT_TAIL, "");
    return plain
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => {
            if (!line.includes("\r")) return line.replace(CONTROL, "");
            // 진행 막대처럼 \r로 같은 줄을 덮어쓴 줄은 마지막으로 쓴 내용만 남긴다
            const parts = line.split("\r");
            for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i].length > 0) return parts[i].replace(CONTROL, "");
            }
            return "";
        })
        .join("\n");
}
