import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';

export default defineConfig({
    plugins: [react(), viteSingleFile()],
    resolve: {
        alias: {
            '@siglo/ide-protocol': path.resolve(__dirname, '../ide-protocol/src/index.ts'),
        },
    },
    build: {
        target: 'esnext',
        assetsInlineLimit: 100000000,
        chunkSizeWarningLimit: 100000000,
        cssCodeSplit: false,
        brotliSize: false,
        rollupOptions: {
            output: {
                inlineDynamicImports: true,
            },
        },
    },
});
