import {createContext} from "react";

// 지금 그리는 탭의 id — 답변 속 파일 경로를 그 탭의 작업 폴더 기준으로 IDE에서 열 때 쓴다 (ChatTabView가 넣는다)
export const TabIdContext = createContext<string>("");
