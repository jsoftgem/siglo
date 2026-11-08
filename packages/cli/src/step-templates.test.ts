import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateStep, GenerateStepOptions } from './index';

const root = path.resolve(__dirname, '../../..');
describe('ecosystem step generation', function () {
    this.timeout(120000);
    it('rejects invalid options and refuses either destination collision', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siglo-options-'));
        try {
            for (const [name, options] of [
                ['../escape', {}],
                ['$', {}],
                ['a--b', {}],
                ['ok', { type: 'http' }],
                ['ok', { type: 'http', url: 'javascript:alert(1)' }],
                ['ok', { type: 'ai', provider: 'invalid', model: 'x' }],
                ['ok', { type: 'ai', provider: 'openai', model: '' }],
                ['ok', { type: 'crypto', provider: 'invalid' }],
                ['ok', { type: 'notification', channel: 'sms', interactive: true }],
                ['ok', { type: 'notification', channel: 'email', interactive: 'false' }],
                ['ok', { url: 'x' }],
            ] as [string, GenerateStepOptions][])
                assert.throws(() => generateStep(name, dir, options));
            assert.deepEqual(fs.readdirSync(dir), []);
            const result = generateStep('generic', dir);
            const original = fs.readFileSync(result.filePath, 'utf8');
            assert.throws(() => generateStep('generic', dir));
            assert.equal(fs.readFileSync(result.filePath, 'utf8'), original);
            fs.unlinkSync(result.filePath);
            assert.throws(() => generateStep('generic', dir));
            assert.equal(fs.existsSync(result.filePath), false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('compiles and runs generated offline tests in a consumer project', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siglo-consumer-'));
        try {
            fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
            fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
            fs.writeFileSync(
                path.join(dir, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        target: 'ES2022',
                        module: 'Node16',
                        moduleResolution: 'Node16',
                        strict: true,
                        esModuleInterop: true,
                        skipLibCheck: true,
                        noEmit: true,
                    },
                    include: ['src/**/*.ts'],
                }),
            );
            const options: GenerateStepOptions[] = [
                { type: 'http', url: 'https://example.test/charges' },
                { type: 'http', url: 'https://example.test/charges?value="%60${injection}' },
                ...['stripe', 'github', 'shopify', 'slack', 'svix', 'generic-hmac'].map(
                    provider => ({ type: 'crypto', provider }) as GenerateStepOptions,
                ),
                ...['email', 'slack', 'discord', 'sms', 'push'].map(
                    channel => ({ type: 'notification', channel }) as GenerateStepOptions,
                ),
                { type: 'notification', channel: 'email', interactive: true },
                { type: 'notification', channel: 'slack', interactive: true },
                ...['openai', 'anthropic', 'gemini', 'ollama'].map(
                    provider =>
                        ({
                            type: 'ai',
                            provider,
                            model: 'caller-model-"` ${throw new Error("injected")}\n',
                        }) as GenerateStepOptions,
                ),
            ];
            const tests = options.map((o, i) => generateStep(`fixture${i}`, dir, o).testPath);
            execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', dir], {
                stdio: 'pipe',
            });
            execFileSync(
                process.execPath,
                [
                    '--import',
                    path.join(root, 'node_modules/tsx/dist/loader.mjs'),
                    '--test',
                    '--test-concurrency=1',
                    ...tests,
                ],
                { cwd: dir, stdio: 'pipe' },
            );
        } catch (error: any) {
            throw new Error(String(error.stdout) + String(error.stderr) + error.message);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports command option errors before creating files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siglo-command-'));
        try {
            for (const args of [
                ['--type=http'],
                ['--type=unknown'],
                ['--type=ai', '--provider=openai'],
                ['--interactive=maybe'],
                ['--typo=http'],
                ['--type=http', '--type=ai'],
            ]) {
                const result = spawnSync(
                    process.execPath,
                    [path.join(root, 'packages/cli/dist/bin.js'), 'generate', 'step', 'example', ...args],
                    { cwd: dir },
                );
                assert.equal(result.status, 1);
                assert.match(String(result.stderr), /Error:/);
                assert.deepEqual(fs.readdirSync(dir), []);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
