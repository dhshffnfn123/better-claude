import React, { useEffect, useState } from "react";
import {ConfigProvider} from "antd";
import {RouterProvider} from "react-router-dom";
import router from "./router";
import SplashScreen from "./components/SplashScreen";

const App = () => {
    const [splash, setSplash] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => setSplash(false), 1800);
        return () => clearTimeout(timer);
    }, []);

    return (
        <ConfigProvider>
            <SplashScreen visible={splash} />
            <RouterProvider router={router} />
        </ConfigProvider>
    );
};

export default App;
