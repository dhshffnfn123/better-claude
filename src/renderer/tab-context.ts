import {createContext} from "react";

// 지금 그리는 탭의 id — 답변 속 파일 경로를 그 탭의 작업 폴더 기준으로 IDE에서 열 때 쓴다 (ChatTabView가 넣는다)
export const TabIdContext = createContext<string>("");

// 그림 확대 창 열기 (ChatTabView의 확대 창) — 답변 속 마크다운 그림처럼 MessageItem 밖에서 그려지는 것이 쓴다
export const ImageViewerContext = createContext<((src: string) => void) | null>(null);

// HTML 미리보기를 오른쪽 패널에 크게 연다 (셸이 그린다 — ChatTabView가 넣는다). 없으면 "크게 보기"를 숨긴다.
// html·svg = 답변 속 코드 블록 글, file = Claude가 만든 .html 파일 (main이 주소를 내준다)
export interface PreviewRequest {
    title: string;
    html?: string;
    svg?: string;
    file?: string;
}

export const PreviewOpenContext = createContext<((req: PreviewRequest) => void) | null>(null);

// 이 답변을 지금 받는 중인가 — 코드 블록이 아직 덜 쓰였을 수 있어 미리보기 대신 코드를 보인다 (MessageItem이 넣는다)
export const ReplyLiveContext = createContext<boolean>(false);

// 답변 속 도구 줄 ↔ 그 줄이 띄운 백그라운드 작업 (ChatTabView가 넣는다). Bash·에이전트를 백그라운드로 띄운 줄은
// 바로 ✓(끝남)로 보였다 — 작업은 몇 분째 도는데. 이제 "실행 중 1:51" → "완료"/"실패"를 보이고, 누르면 패널에서 연다.
export interface BackgroundLink {
    taskId: string;
    running: boolean;
    startedAt?: number;
    endedAt?: number;
    status?: "completed" | "failed" | "stopped";
    exitCode?: number;
}

export interface BackgroundLinks {
    byToolUse: Map<string, BackgroundLink>;
    open: (taskId: string) => void;
}

export const BackgroundLinksContext = createContext<BackgroundLinks | null>(null);
