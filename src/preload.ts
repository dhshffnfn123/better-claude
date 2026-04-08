import {contextBridge} from "electron";
import {appApi} from "./preload/api";

contextBridge.exposeInMainWorld("appApi", appApi);
