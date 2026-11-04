import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = await mkdtemp(join(tmpdir(), 'siglo-vscode-'));
try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // npm accepts scopes; VS Code's extension identifier must be unscoped.
  manifest.name = 'siglo-workflow-explorer';
  manifest.files = ['dist/**', 'media/**', 'README.md', 'LICENSE'];
  delete manifest.devDependencies;
  delete manifest.scripts;
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const file of ['dist', 'media', 'README.md', 'LICENSE']) await cp(join(root, file), join(staging, file), { recursive: true });
  const vsce = join(require.resolve('@vscode/vsce/package.json'), '..', 'vsce');
  const result = spawnSync(process.execPath, [vsce, 'package', '--no-dependencies', '-o', join(root, `siglo-workflow-explorer-${manifest.version}.vsix`)], { cwd: staging, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`vsce exited with status ${result.status}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
