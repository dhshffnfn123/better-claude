import {defineConfig} from "vite";
export default defineConfig({
    build: {
        lib: {entry: "src/_probe_sdk.ts", formats: ["cjs"], fileName: "probe"},
        rollupOptions: {external: ["electron", "@anthropic-ai/claude-agent-sdk"]},
        minify: false,
    },
});
