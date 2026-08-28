import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
            // claude-agent-sdk는 ESM 전용이라 CJS 번들에 인라인할 수 없다
            // (rollup이 파싱 단계에서 실패). 외부로 두고 런타임에 동적 import한다.
            external: ['node-pty', 'electron', '@anthropic-ai/claude-agent-sdk'],
        },
    },
});
