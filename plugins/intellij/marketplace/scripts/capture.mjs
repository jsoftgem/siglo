// Capture the plugin's actual bundled webview with analyzer output, without IDE chrome.
// Run from any directory with Node.js 22+; CHROME_BIN may override Chrome's path.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const plugin = process.argv[2] || 'intellij';
if (!['intellij', 'vscode'].includes(plugin)) throw new Error('Expected intellij or vscode');
const marketplace = resolve(root, 'plugins', plugin, 'marketplace');
const require = createRequire(import.meta.url);
const { parseWorkflowFile } = require(resolve(root, 'packages/ide-analysis/dist/parser.js'));
const fixture = resolve(marketplace, 'demo.workflow.ts');
const graph = parseWorkflowFile({
    uri: 'file:///demo/demo.workflow.ts',
    content: await readFile(fixture, 'utf8'),
    workflowName: 'checkoutWorkflow',
    documentVersion: 1,
});
if (graph.nodes.length === 0 || graph.workflows.length !== 2 || graph.unresolved.length) {
    throw new Error('Screenshot fixture must resolve to two workflows without unresolved nodes.');
}
const output = resolve(marketplace, 'screenshots');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(resolve(tmpdir(), 'siglo-screenshots-'));
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
            reject(new Error(`Chrome exited: ${code}\n${logs}`));
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
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
    });
    const bundle =
        plugin === 'vscode'
            ? 'plugins/vscode/dist/index.html'
            : 'plugins/intellij/src/main/resources/ide-ui/index.html';
    await call('Page.navigate', { url: pathToFileURL(resolve(root, bundle)).href });
    await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (window.__SIGLO_BRIDGE__ && document.querySelector('header')) { clearInterval(timer); resolve(true); }
      else if (Date.now() - start > 10000) { clearInterval(timer); reject(new Error('UI did not mount')); }
    }, 50);
  })`);
    const settle = () =>
        evaluate(
            'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
        );
    const screenshot = async name => {
        await settle();
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(resolve(output, name), Buffer.from(data, 'base64'));
        console.log(`Captured ${name}`);
    };
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(graph)}})`);
    const payment = graph.nodes.find(node => node.name === 'authorizePayment');
    if (!payment) throw new Error('Missing authorizePayment step');
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(payment.id)}})`);
    await screenshot('01-workflow-graph.png');
    const validate = graph.nodes.find(node => node.name === 'validateOrder');
    if (!validate) throw new Error('Missing validateOrder step');
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(validate.id)}})`);
    await screenshot('02-step-input-contracts.png');
    await evaluate(`document.querySelector('[title="Inspect workflow: checkoutWorkflow"]').click()`);
    await screenshot('03-workflow-settings.png');
    await evaluate(
        `const selector = document.querySelector('select'); selector.value = '__ALL__'; selector.dispatchEvent(new Event('change', {bubbles:true}));`,
    );
    await screenshot('04-all-workflows.png');

    // 05-ecosystem-telemetry: Load telemetry recording and inspect authorizePayment with matched recorded execution
    const telemetryDoc = {
        version: 1,
        fileName: 'checkout-telemetry.json',
        importedAt: '2026-11-11T12:00:00.000Z',
        records: [
            {
                version: 1,
                workflowName: 'checkoutWorkflow',
                stepIdentity: 'authorizePayment',
                attempt: 2,
                timestamp: '2026-11-11T12:00:01.000Z',
                inspection: {
                    version: 1,
                    kind: 'http',
                    outcome: 'success',
                    durationMs: 245,
                    method: 'POST',
                    url: 'https://api.payments.example.com/v1/charge',
                    status: 200,
                    retryAttempts: 1,
                    requestAttempt: 2,
                    retryDelayMs: 200,
                    policy: 'allowed',
                    traceId: 'tr_pay_7721',
                },
            },
        ],
    };
    await evaluate(
        `const sel = document.querySelector('select'); if (sel) { sel.value = 'checkoutWorkflow'; sel.dispatchEvent(new Event('change', {bubbles:true})); }`,
    );
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setTelemetry', document:${JSON.stringify(telemetryDoc)}})`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(payment.id)}})`);
    await screenshot('05-ecosystem-telemetry.png');
} finally {
    socket?.close();
    browser.kill();
    await new Promise(resolveExit => {
        if (browser.exitCode !== null || browser.signalCode !== null) resolveExit();
        else browser.once('exit', resolveExit);
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
