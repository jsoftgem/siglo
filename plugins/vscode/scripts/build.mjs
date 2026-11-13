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

await build({
    entryPoints: [`${root}../../packages/ide-analysis/src/execution.ts`],
    outfile: `${root}dist/prepare.cjs`,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
});
for (const file of ['supervisor.cjs', 'worker.cjs'])
    await copyFile(`${root}../../packages/ide-runner/${file}`, `${root}dist/${file}`);
