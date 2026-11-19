import {createContext} from "react";

// 지금 그리는 탭의 id — 답변 속 파일 경로를 그 탭의 작업 폴더 기준으로 IDE에서 열 때 쓴다 (ChatTabView가 넣는다)
export const TabIdContext = createContext<string>("");

// 그림 확대 창 열기 (Lightbox.tsx의 useLightbox) — from = 누른 그림 요소(앞뒤 그림으로 넘길 때의 기준).
// 누르면 크게 보는 요소에는 data-zoomable(ZOOMABLE)을 붙인다 — 그래야 확대 창에서 앞뒤로 넘어올 수 있다.
export type OpenImage = (src: string, from?: HTMLElement | null) => void;
export const ImageViewerContext = createContext<OpenImage | null>(null);

// 접힌 긴 내용(Collapsible)을 펼치라는 DOM 이벤트 — ⌘F 찾기가 접힌 곳에서 찾았을 때 그 상자(data-collapsed)에 보낸다
export const EXPAND_EVENT = "bc-expand";

// 작업 파일 패널에서 파일을 끌 때의 자료 종류 — 탭 화면(입력창)에 놓으면 @로 넣는다. 값 = 작업 폴더 기준 상대 경로(밖이면 절대 경로).
// 글자(text/plain)로 싣지 않는다: 그러면 입력창이 경로를 글로 끼워 넣는다.
export const FILE_DRAG_TYPE = "application/x-bc-path";

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
    terminated?: boolean; // 다른 명령이 신호로 끝냈다 ("종료됨")
}

export interface BackgroundLinks {
    byToolUse: Map<string, BackgroundLink>;
    open: (taskId: string) => void;
}

export const BackgroundLinksContext = createContext<BackgroundLinks | null>(null);
