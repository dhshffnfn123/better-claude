import {createHashRouter} from "react-router-dom";
import ChatPage from "./pages/main/chat.page";

const router = createHashRouter([
    {
        path: "/",
        element: <ChatPage />,
    },
]);

export default router;
