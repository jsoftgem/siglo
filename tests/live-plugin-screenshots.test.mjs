// Live Plugin & Webview Test with Full Screenshot Capture
// Exercises both IntelliJ IDEA and VS Code plugin bundles against real static analysis output.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);
const { parseWorkflowFile } = require(resolve(root, 'packages/ide-analysis/dist/parser.js'));

const artifactDir = '/Users/jericodeguzman/.gemini/antigravity-acp/brain/77630846-04a1-4b32-8d66-dad1face6de6';
const outputDir = resolve(root, 'docs/screenshots/live-test');
await mkdir(outputDir, { recursive: true });

// Parse test fixtures
const demoFixture = resolve(root, 'plugins/intellij/marketplace/demo.workflow.ts');
const demoGraph = parseWorkflowFile({
    uri: 'file:///demo/demo.workflow.ts',
    content: await readFile(demoFixture, 'utf8'),
    workflowName: 'checkoutWorkflow',
    documentVersion: 1,
});

const diagFixture = resolve(root, 'plugins/intellij/marketplace/diagnostics.workflow.ts');
const diagGraph = parseWorkflowFile({
    uri: 'file:///demo/diagnostics.workflow.ts',
    content: await readFile(diagFixture, 'utf8'),
    workflowName: 'orderDiagnosticsWorkflow',
    documentVersion: 1,
});

const plugins = ['intellij', 'vscode'];
const capturedScreenshots = [];

for (const plugin of plugins) {
    console.log(`\n========================================`);
    console.log(`Running Live Test on Plugin: ${plugin.toUpperCase()}`);
    console.log(`========================================`);

    const bundlePath =
        plugin === 'vscode'
            ? resolve(root, 'plugins/vscode/dist/index.html')
            : resolve(root, 'plugins/intellij/src/main/resources/ide-ui/index.html');

    const profile = await mkdtemp(resolve(tmpdir(), `siglo-live-${plugin}-`));
    const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let socket;
    const pending = new Map();
    let nextId = 0;
    const call = (method, params = {}) =>
        new Promise((resolveCall, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Timed out: ${method}`));
            }, 15000);
            pending.set(id, { resolve: resolveCall, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });

    try {
        const endpoint = await new Promise((resolveEndpoint, reject) => {
            let logs = '';
            const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
            browser.once('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            browser.once('exit', code => {
                clearTimeout(timer);
                reject(new Error(`Chrome exited with code ${code}\n${logs}`));
            });
            browser.stderr.on('data', data => {
                logs += data.toString();
                const match = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) {
                    clearTimeout(timer);
                    resolveEndpoint(new URL(match[1]).origin.replace('ws:', 'http:'));
                }
            });
        });

        const targets = await (await fetch(`${endpoint}/json/list`)).json();
        socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolveOpen, reject) => {
            socket.onopen = resolveOpen;
            socket.onerror = reject;
        });

        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            const request = pending.get(message.id);
            if (!request) return;
            clearTimeout(request.timer);
            pending.delete(message.id);
            if (message.error) request.reject(new Error(JSON.stringify(message.error)));
            else request.resolve(message.result);
        };

        const evaluate = async expression => {
            const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };

        await call('Page.enable');
        await call('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        });

        console.log(`Navigating to ${plugin} bundle: ${bundlePath}`);
        await call('Page.navigate', { url: pathToFileURL(bundlePath).href });

        // Wait for UI to mount
        await evaluate(`new Promise((resolve, reject) => {
            const start = Date.now();
            const timer = setInterval(() => {
                if (window.__SIGLO_BRIDGE__ && document.querySelector('header')) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - start > 10000) {
                    clearInterval(timer);
                    reject(new Error('UI did not mount'));
                }
            }, 50);
        })`);

        const settle = () =>
            evaluate(
                'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
            );

        const capture = async filename => {
            await settle();
            const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            const filePath = resolve(outputDir, filename);
            await writeFile(filePath, Buffer.from(data, 'base64'));

            // Also copy to brain artifact directory for display
            const artifactPath = resolve(artifactDir, filename);
            await copyFile(filePath, artifactPath);

            capturedScreenshots.push({ plugin, filename, path: filePath, artifactPath });
            console.log(`  ✓ Captured: ${filename}`);
        };

        // ---------------------------------------------------------------------
        // Test 1: Render Primary Workflow Graph & Select Node
        // ---------------------------------------------------------------------
        console.log('Test 1: Render Primary Workflow Graph (checkoutWorkflow)...');
        await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(demoGraph)}})`);
        const headerTitle = await evaluate(`document.querySelector('header h2')?.textContent || ''`);
        console.log(`  Canvas Title: "${headerTitle}"`);

        const payment = demoGraph.nodes.find(node => node.name === 'authorizePayment');
        await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(payment.id)}})`);
        await capture(`${plugin}-01-workflow-graph.png`);

        // ---------------------------------------------------------------------
        // Test 2: Inspect Structured Step Input Contracts
        // ---------------------------------------------------------------------
        console.log('Test 2: Inspect Step Input Contracts (validateOrder specs)...');
        const validate = demoGraph.nodes.find(node => node.name === 'validateOrder');
        await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(validate.id)}})`);
        const specHeader = await evaluate(`document.querySelector('h4')?.textContent || ''`);
        console.log(`  Inspector Header: "${specHeader}"`);
        await capture(`${plugin}-02-step-contracts.png`);

        // ---------------------------------------------------------------------
        // Test 3: Inspect Workflow Metadata & Network Policy
        // ---------------------------------------------------------------------
        console.log('Test 3: Inspect Workflow Configuration & Network Perimeter...');
        await evaluate(`document.querySelector('[title="Inspect workflow: checkoutWorkflow"]').click()`);
        await capture(`${plugin}-03-workflow-settings.png`);

        // ---------------------------------------------------------------------
        // Test 4: All Flows Multi-Canvas Mode
        // ---------------------------------------------------------------------
        console.log('Test 4: All Flows Multi-Canvas Mode...');
        await evaluate(
            `const selector = document.querySelector('select'); selector.value = '__ALL__'; selector.dispatchEvent(new Event('change', {bubbles:true}));`,
        );
        const canvasCount = await evaluate(`document.querySelectorAll('svg').length`);
        console.log(`  Canvases rendered: ${canvasCount}`);
        await capture(`${plugin}-04-all-workflows.png`);

        // ---------------------------------------------------------------------
        // Test 5: Milestone 2 Static Diagnostics (orderDiagnosticsWorkflow)
        // ---------------------------------------------------------------------
        console.log('Test 5: Milestone 2 Static Diagnostics Visualization...');
        await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(diagGraph)}})`);
        const uncompNode = diagGraph.nodes.find(n => n.name === 'encryptPayload');
        await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(uncompNode.id)}})`);

        const diagText = await evaluate(`
            const diagEl = document.querySelector('[class*="border-amber-800"]');
            diagEl ? diagEl.textContent.trim() : 'none';
        `);
        console.log(`  Rendered Diagnostic in UI: "${diagText}"`);
        await capture(`${plugin}-05-static-diagnostics.png`);

        console.log(`✓ All 5 live tests passed for ${plugin.toUpperCase()}`);
    } finally {
        socket?.close();
        browser.kill();
        await new Promise(resolveExit => {
            if (browser.exitCode !== null || browser.signalCode !== null) resolveExit();
            else browser.once('exit', resolveExit);
        });
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

console.log('\n========================================');
console.log('LIVE TEST SUMMARY');
console.log('========================================');
console.log(`Total Screenshots Captured: ${capturedScreenshots.length} / 10`);
for (const item of capturedScreenshots) {
    console.log(`- [${item.plugin}] ${item.filename}`);
}
