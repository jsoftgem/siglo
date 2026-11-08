import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
await build({
    entryPoints: [`${root}src/extension.ts`],
    outfile: `${root}dist/extension.js`,
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    format: 'cjs',
});
await build({
    entryPoints: [`${root}../../packages/ide-analysis/src/bin.ts`],
    outfile: `${root}dist/analyzer.js`,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: true,
});
await copyFile(`${root}../../packages/ide-ui/dist/index.html`, `${root}dist/index.html`);
