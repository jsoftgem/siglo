import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = `${root}plugins/intellij/src/main/resources/ide-runner`;
await mkdir(out, { recursive: true });
await build({
    entryPoints: [`${root}packages/ide-analysis/src/execution.ts`],
    outfile: `${out}/prepare.cjs`,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
});
for (const file of ['supervisor.cjs', 'worker.cjs'])
    await copyFile(`${root}packages/ide-runner/${file}`, `${out}/${file}`);

const analysisOut = `${root}plugins/intellij/src/main/resources/ide-analysis`;
await mkdir(analysisOut, { recursive: true });
await build({
    entryPoints: [`${root}packages/ide-analysis/src/bin.ts`],
    outfile: `${analysisOut}/analyzer.js`,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: true,
});

await mkdir(`${root}plugins/intellij/src/main/resources/ide-ui`, { recursive: true });
await copyFile(
    `${root}packages/ide-ui/dist/index.html`,
    `${root}plugins/intellij/src/main/resources/ide-ui/index.html`,
);
