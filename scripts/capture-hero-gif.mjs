// Capture a 15-second split-screen looping GIF showing:
// Left:  Live IDE Workflow Visualizer (@siglo/ide-ui) updating as code evolves
// Right: Live @siglo/monitor DevTools animating a checkout retry + LIFO Saga rollback waterfall
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const { parseWorkflowFile } = require(resolve(root, 'packages/ide-analysis/dist/parser.js'));
const { createMonitorServer } = require(resolve(root, 'packages/monitor/dist/index.js'));

// ---------------------------------------------------------------------------
// Pure JS GIF89a Encoder (256-color adaptive palette + LZW compression)
// ---------------------------------------------------------------------------
function quantizeFrame(rgba, width, height) {
    const pixelCount = width * height;
    const hist = new Int32Array(32768);
    const rSum = new Float64Array(32768);
    const gSum = new Float64Array(32768);
    const bSum = new Float64Array(32768);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 4;
        const r = rgba[off];
        const g = rgba[off + 1];
        const b = rgba[off + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        hist[key]++;
        rSum[key] += r;
        gSum[key] += g;
        bSum[key] += b;
    }

    const buckets = [];
    for (let key = 0; key < 32768; key++) {
        if (hist[key] > 0) {
            const count = hist[key];
            buckets.push({
                count,
                r: Math.round(rSum[key] / count),
                g: Math.round(gSum[key] / count),
                b: Math.round(bSum[key] / count),
            });
        }
    }
    buckets.sort((a, b) => b.count - a.count);

    const palette = [];
    const used = new Uint8Array(buckets.length);

    for (const minDistSq of [300, 120, 40, 0]) {
        for (let i = 0; i < buckets.length && palette.length < 256; i++) {
            if (used[i]) continue;
            const c = buckets[i];
            let tooClose = false;
            if (minDistSq > 0) {
                for (let j = 0; j < palette.length; j++) {
                    const p = palette[j];
                    const dr = c.r - p.r;
                    const dg = c.g - p.g;
                    const db = c.b - p.b;
                    if (dr * dr + dg * dg + db * db < minDistSq) {
                        tooClose = true;
                        break;
                    }
                }
            }
            if (!tooClose) {
                used[i] = 1;
                palette.push(c);
            }
        }
        if (palette.length >= 256) break;
    }

    while (palette.length < 256) {
        palette.push({ r: 0, g: 0, b: 0 });
    }

    const cache = new Int16Array(32768).fill(-1);
    const indices = new Uint8Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 4;
        const r = rgba[off];
        const g = rgba[off + 1];
        const b = rgba[off + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let idx = cache[key];
        if (idx === -1) {
            let bestDist = Infinity;
            let bestIdx = 0;
            for (let p = 0; p < 256; p++) {
                const pc = palette[p];
                const dr = r - pc.r;
                const dg = g - pc.g;
                const db = b - pc.b;
                const d = dr * dr + dg * dg + db * db;
                if (d < bestDist) {
                    bestDist = d;
                    bestIdx = p;
                    if (d === 0) break;
                }
            }
            idx = bestIdx;
            cache[key] = idx;
        }
        indices[i] = idx;
    }

    const paletteBytes = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        paletteBytes[i * 3] = palette[i].r;
        paletteBytes[i * 3 + 1] = palette[i].g;
        paletteBytes[i * 3 + 2] = palette[i].b;
    }

    return { paletteBytes, indices };
}

function lzwEncode(indices, minCodeSize = 8) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const out = [];

    let curByte = 0;
    let curBits = 0;
    const subBlock = [];

    const flushSubBlock = () => {
        if (subBlock.length > 0) {
            out.push(subBlock.length);
            for (let i = 0; i < subBlock.length; i++) out.push(subBlock[i]);
            subBlock.length = 0;
        }
    };

    const writeCode = (code, bits) => {
        curByte |= code << curBits;
        curBits += bits;
        while (curBits >= 8) {
            subBlock.push(curByte & 0xff);
            if (subBlock.length === 255) flushSubBlock();
            curByte >>= 8;
            curBits -= 8;
        }
    };

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const table = new Int32Array(4096 * 256).fill(-1);

    writeCode(clearCode, codeSize);

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const tIdx = (prefix << 8) | k;
        const hit = table[tIdx];
        if (hit !== -1) {
            prefix = hit;
        } else {
            writeCode(prefix, codeSize);
            if (nextCode < 4096) {
                table[tIdx] = nextCode++;
                if (nextCode > 1 << codeSize && codeSize < 12) {
                    codeSize++;
                }
            } else {
                writeCode(clearCode, codeSize);
                table.fill(-1);
                codeSize = minCodeSize + 1;
                nextCode = eoiCode + 1;
            }
            prefix = k;
        }
    }

    writeCode(prefix, codeSize);
    writeCode(eoiCode, codeSize);

    if (curBits > 0) {
        subBlock.push(curByte & 0xff);
    }
    flushSubBlock();
    out.push(0);
    return Buffer.from(out);
}

function encodeGif(frames, width, height) {
    const chunks = [];
    const header = Buffer.alloc(13);
    header.write('GIF89a', 0, 'ascii');
    header.writeUInt16LE(width, 6);
    header.writeUInt16LE(height, 8);
    header[10] = 0x70;
    header[11] = 0;
    header[12] = 0;
    chunks.push(header);

    // NETSCAPE2.0 infinite loop extension
    chunks.push(
        Buffer.from([
            0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00,
            0x00,
        ]),
    );

    for (const frame of frames) {
        const { paletteBytes, indices } = quantizeFrame(frame.rgba, width, height);
        const gce = Buffer.alloc(8);
        gce[0] = 0x21;
        gce[1] = 0xf9;
        gce[2] = 0x04;
        gce[3] = 0x00;
        gce.writeUInt16LE(frame.delayCs, 4);
        gce[6] = 0x00;
        gce[7] = 0x00;
        chunks.push(gce);

        const desc = Buffer.alloc(10);
        desc[0] = 0x2c;
        desc.writeUInt16LE(0, 1);
        desc.writeUInt16LE(0, 3);
        desc.writeUInt16LE(width, 5);
        desc.writeUInt16LE(height, 7);
        desc[9] = 0x87;
        chunks.push(desc);

        chunks.push(Buffer.from(paletteBytes));
        chunks.push(Buffer.from([0x08]));
        chunks.push(lzwEncode(indices, 8));
    }

    chunks.push(Buffer.from([0x3b]));
    return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Progressive IDE Workflow Sources for Left Pane
// ---------------------------------------------------------------------------
const sourceStage1 = `
import { Step, flow } from '@siglo/core';

const validateOrder = Step.create('validateOrder', async (input: any) => input)
    .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
    .spec('sku', { require: true })
    .spec('amountCents', { validate: (value: number) => value > 0 })
    .timeout(1000);

const reserveStock = Step.create('reserveStock', { retries: 1, timeoutMs: 2000 }, async () => ({}))
    .compensate(async () => {});

export const checkoutWorkflow = flow(validateOrder, reserveStock).timeout(10000).version('v1.0');
`;

const sourceStage2 = `
import { Step, flow } from '@siglo/core';
import { httpStep } from '@siglo/http';
import { sendNotificationStep } from '@siglo/notifications';

const validateOrder = Step.create('validateOrder', async (input: any) => input)
    .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
    .spec('sku', { require: true })
    .spec('currency', { default: 'USD' })
    .spec('amountCents', { validate: (value: number) => value > 0 })
    .timeout(1000);

const reserveStock = Step.create('reserveStock', { retries: 1, timeoutMs: 2000 }, async () => ({}))
    .compensate(async () => {});

const chargePayment = httpStep('chargePayment', {
    method: 'POST',
    url: 'https://api.payments.example.com/v1/charge',
    maxRetries: 2,
    timeoutMs: 4000,
}).compensate(async () => {});

const arrangeShipping = Step.create('arrangeShipping', { timeoutMs: 3000 }, async () => ({}));

export const checkoutWorkflow = flow(validateOrder, reserveStock, chargePayment, arrangeShipping)
    .timeout(15000)
    .version('v1.0')
    .networkPolicy({
        defaultPolicy: 'deny',
        allowedHosts: ['api.payments.example.com', 'shipping.example.com'],
        allowLocalhost: false,
    });

const composeReceipt = Step.create('composeReceipt', async () => ({}));
const deliverReceipt = sendNotificationStep('deliverReceipt', { channel: 'email', template: 'tpl_receipt_v1' });
export const receiptWorkflow = flow(composeReceipt, deliverReceipt).timeout(5000).version('v1.0');
`;

const graphStage1 = parseWorkflowFile({
    uri: 'file:///demo/checkout.workflow.ts',
    content: sourceStage1,
    workflowName: 'checkoutWorkflow',
    documentVersion: 1,
});

const graphStage2 = parseWorkflowFile({
    uri: 'file:///demo/checkout.workflow.ts',
    content: sourceStage2,
    workflowName: 'checkoutWorkflow',
    documentVersion: 2,
});

const astForMonitor = {
    id: 'checkoutWorkflow',
    name: 'checkoutWorkflow',
    type: 'sequence',
    children: [
        { id: 'validateOrder', name: 'validateOrder', type: 'step' },
        { id: 'reserveStock', name: 'reserveStock', type: 'step' },
        { id: 'chargePayment', name: 'chargePayment', type: 'step' },
        { id: 'arrangeShipping', name: 'arrangeShipping', type: 'step' },
    ],
};

const WIDTH = 1280;
const HEIGHT = 720;

const monitor = await createMonitorServer({
    port: 0,
    host: '127.0.0.1',
    allowRemoteResume: false,
});

const profile = await mkdtemp(resolve(tmpdir(), 'siglo-hero-gif-'));
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
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
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

    const settle = () =>
        evaluate(
            'document.fonts.ready.then(() => new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 80)))',
        );

    const grabShot = async () => {
        await settle();
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        return data;
    };

    await call('Page.enable');

    // =======================================================================
    // PHASE A: Capture 8 IDE Workflow Visualizer States (Left Pane)
    // =======================================================================
    await call('Emulation.setDeviceMetricsOverride', {
        width: 1000,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false,
    });
    const ideBundleUrl = pathToFileURL(resolve(root, 'packages/ide-ui/dist/index.html')).href;
    await call('Page.navigate', { url: ideBundleUrl });
    await evaluate(`new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (window.__SIGLO_BRIDGE__ && document.querySelector('header')) { clearInterval(timer); resolve(true); }
            else if (Date.now() - start > 10000) { clearInterval(timer); reject(new Error('IDE UI did not mount')); }
        }, 50);
    })`);

    const leftShots = [];
    const reserveNode1 = graphStage1.nodes.find(n => n.name === 'reserveStock');
    const validateNode = graphStage2.nodes.find(n => n.name === 'validateOrder');
    const reserveNode2 = graphStage2.nodes.find(n => n.name === 'reserveStock');
    const chargeNode = graphStage2.nodes.find(n => n.name === 'chargePayment');
    const shipNode = graphStage2.nodes.find(n => n.name === 'arrangeShipping');

    // Left 1: Initial 2-step flow
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(graphStage1)}})`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(reserveNode1.id)}})`);
    leftShots.push(await grabShot());

    // Left 2: Expanded 4-step flow, select chargePayment
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(graphStage2)}})`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(chargeNode.id)}})`);
    leftShots.push(await grabShot());

    // Left 3: Select validateOrder (input contracts)
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(validateNode.id)}})`);
    leftShots.push(await grabShot());

    // Left 4: Select arrangeShipping
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(shipNode.id)}})`);
    leftShots.push(await grabShot());

    // Left 5: Select chargePayment (saga compensation)
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(chargeNode.id)}})`);
    leftShots.push(await grabShot());

    // Left 6: Select reserveStock (saga compensation)
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(reserveNode2.id)}})`);
    leftShots.push(await grabShot());

    // Left 7: Load telemetry recording onto chargePayment
    const telemetryDoc = {
        version: 1,
        fileName: 'checkout-ord-9042.telemetry.json',
        importedAt: '2026-11-13T02:30:00.000Z',
        records: [
            {
                version: 1,
                workflowName: 'checkoutWorkflow',
                stepIdentity: 'chargePayment',
                attempt: 2,
                timestamp: '2026-11-13T02:30:00.000Z',
                inspection: {
                    version: 1,
                    kind: 'http',
                    outcome: 'success',
                    durationMs: 142,
                    method: 'POST',
                    url: 'https://api.payments.example.com/v1/charge',
                    status: 200,
                    retryAttempts: 1,
                    requestAttempt: 2,
                    retryDelayMs: 55,
                    policy: 'allowed',
                    traceId: 'tr_chk_9042',
                },
            },
        ],
    };
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setTelemetry', document:${JSON.stringify(telemetryDoc)}})`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(chargeNode.id)}})`);
    leftShots.push(await grabShot());

    // Left 8: All Flows view
    await evaluate(
        `const selector = document.querySelector('select'); if (selector) { selector.value = '__ALL__'; selector.dispatchEvent(new Event('change', {bubbles:true})); }`,
    );
    leftShots.push(await grabShot());
    console.log('Captured 8 IDE Workflow Visualizer frames');

    // =======================================================================
    // PHASE B: Capture 8 @siglo/monitor States (Right Pane)
    // =======================================================================
    await call('Emulation.setDeviceMetricsOverride', {
        width: 1160,
        height: 1068,
        deviceScaleFactor: 1,
        mobile: false,
    });

    const stackId = 'chk9042';
    const baseTs = Date.now() - 5000;
    const emitEvent = ev => {
        monitor.store.addEvent(ev);
        monitor.sse.broadcast(ev);
    };

    emitEvent({
        type: 'flow:start',
        stackId,
        flowName: 'checkoutWorkflow',
        namespace: 'checkout-prod',
        version: 'v1.0',
        ast: astForMonitor,
        timestamp: baseTs,
    });
    emitEvent({
        type: 'step:start',
        stackId,
        stepId: 'validateOrder',
        stepName: 'validateOrder',
        attempt: 1,
        timestamp: baseTs + 2,
    });
    emitEvent({
        type: 'step:complete',
        stackId,
        stepId: 'validateOrder',
        stepName: 'validateOrder',
        durationMs: 6,
        timestamp: baseTs + 8,
    });
    emitEvent({
        type: 'context:change',
        stackId,
        stepId: 'validateOrder',
        field: 'orderId',
        value: 'ord_9042',
        timestamp: baseTs + 8,
    });
    emitEvent({
        type: 'step:start',
        stackId,
        stepId: 'reserveStock',
        stepName: 'reserveStock',
        attempt: 1,
        timestamp: baseTs + 10,
    });
    emitEvent({
        type: 'step:complete',
        stackId,
        stepId: 'reserveStock',
        stepName: 'reserveStock',
        durationMs: 24,
        timestamp: baseTs + 34,
    });
    emitEvent({
        type: 'context:change',
        stackId,
        stepId: 'reserveStock',
        field: 'reservationId',
        value: 'res_ord_9042',
        timestamp: baseTs + 34,
    });

    await call('Page.navigate', { url: `http://127.0.0.1:${monitor.port}` });
    await evaluate(`new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            const runItem = Array.from(document.querySelectorAll('div')).find(el => el.textContent && el.textContent.includes('checkoutWorkflow') && el.className && typeof el.className === 'string' && el.className.includes('cursor-pointer'));
            if (runItem) { runItem.click(); clearInterval(timer); resolve(true); }
            else if (Date.now() - start > 10000) { clearInterval(timer); reject(new Error('Monitor run did not load')); }
        }, 50);
    })`);

    const clickMonitorTab = async labelText => {
        await evaluate(`(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes(${JSON.stringify(labelText)}));
            if (btn) btn.click();
        })()`);
    };

    const clickMonitorDagNode = async stepName => {
        await evaluate(`(() => {
            const nodes = Array.from(document.querySelectorAll('div, button'));
            const match = nodes.find(el => el.textContent && el.textContent.includes(${JSON.stringify(stepName)}) && el.className && typeof el.className === 'string' && el.className.includes('cursor-pointer'));
            if (match) match.click();
        })()`);
    };

    const rightShots = [];

    // Right 1: Initial running state (validateOrder & reserveStock complete)
    rightShots.push(await grabShot());

    // Right 2: chargePayment starts and enters RETRYING (Attempt 2)
    emitEvent({
        type: 'step:start',
        stackId,
        stepId: 'chargePayment',
        stepName: 'chargePayment',
        attempt: 1,
        timestamp: baseTs + 40,
    });
    emitEvent({
        type: 'step:retry',
        stackId,
        stepId: 'chargePayment',
        stepName: 'chargePayment',
        attempt: 2,
        maxAttempts: 3,
        error: { message: '503 Payment gateway timeout', name: 'HttpError' },
        timestamp: baseTs + 95,
    });
    await clickMonitorDagNode('chargePayment');
    rightShots.push(await grabShot());

    // Right 3: Switch to Latency Waterfall; chargePayment succeeds (142ms), arrangeShipping starts
    emitEvent({
        type: 'step:complete',
        stackId,
        stepId: 'chargePayment',
        stepName: 'chargePayment',
        durationMs: 142,
        timestamp: baseTs + 182,
    });
    emitEvent({
        type: 'context:change',
        stackId,
        stepId: 'chargePayment',
        field: 'paymentId',
        value: 'pay_ord_9042',
        timestamp: baseTs + 182,
    });
    emitEvent({
        type: 'step:start',
        stackId,
        stepId: 'arrangeShipping',
        stepName: 'arrangeShipping',
        attempt: 1,
        timestamp: baseTs + 185,
    });
    await clickMonitorTab('Latency Waterfall');
    rightShots.push(await grabShot());

    // Right 4: arrangeShipping fails (89ms)
    emitEvent({
        type: 'step:error',
        stackId,
        stepId: 'arrangeShipping',
        stepName: 'arrangeShipping',
        error: { message: 'No courier available in destination region', name: 'CourierError' },
        timestamp: baseTs + 274,
    });
    monitor.store.getRun(stackId).steps['arrangeShipping'].durationMs = 89;
    await evaluate(`(() => {
        const refreshBtn = document.querySelector('button[title*="Refresh"]');
        if (refreshBtn) refreshBtn.click();
    })()`);
    rightShots.push(await grabShot());

    // Right 5: LIFO Saga Rollback 1/2: compensate:chargePayment (64ms)
    emitEvent({
        type: 'step:start',
        stackId,
        stepId: 'compensate:chargePayment',
        stepName: '⏪ compensate:chargePayment (refund)',
        attempt: 1,
        timestamp: baseTs + 276,
    });
    emitEvent({
        type: 'step:complete',
        stackId,
        stepId: 'compensate:chargePayment',
        stepName: '⏪ compensate:chargePayment (refund)',
        durationMs: 64,
        timestamp: baseTs + 340,
    });
    rightShots.push(await grabShot());

    // Right 6: LIFO Saga Rollback 2/2: compensate:reserveStock (24ms) + flow FAILED
    emitEvent({
        type: 'step:start',
        stackId,
        stepId: 'compensate:reserveStock',
        stepName: '⏪ compensate:reserveStock (release)',
        attempt: 1,
        timestamp: baseTs + 342,
    });
    emitEvent({
        type: 'step:complete',
        stackId,
        stepId: 'compensate:reserveStock',
        stepName: '⏪ compensate:reserveStock (release)',
        durationMs: 24,
        timestamp: baseTs + 366,
    });
    emitEvent({
        type: 'context:change',
        stackId,
        stepId: 'compensate:reserveStock',
        field: 'sagaStatus',
        value: 'ROLLED_BACK_CLEANLY',
        timestamp: baseTs + 366,
    });
    emitEvent({
        type: 'flow:complete',
        stackId,
        status: 'FAILED',
        durationMs: 366,
        error: { message: 'No courier available in destination region', name: 'CourierError' },
        timestamp: baseTs + 366,
    });
    rightShots.push(await grabShot());

    // Right 7: Topology (DAG) with arrangeShipping selected
    await clickMonitorTab('Topology (DAG)');
    await clickMonitorDagNode('arrangeShipping');
    rightShots.push(await grabShot());

    // Right 8: Context & State Diff
    await clickMonitorTab('Context & State Diff');
    rightShots.push(await grabShot());
    console.log('Captured 8 @siglo/monitor frames');

    // =======================================================================
    // PHASE C: Composite Split-Screen Frames & Encode 15.0s Looping GIF
    // =======================================================================
    await call('Emulation.setDeviceMetricsOverride', {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await call('Page.navigate', { url: 'about:blank' });
    await evaluate(`(() => {
        document.body.style.margin = '0';
        document.body.style.background = '#090d16';
        const canvas = document.createElement('canvas');
        canvas.id = 'comp';
        canvas.width = ${WIDTH};
        canvas.height = ${HEIGHT};
        document.body.appendChild(canvas);
    })()`);

    const sceneSpecs = [
        {
            delayCs: 180,
            rightBadge: '● RUNNING (2/4 steps)',
            label: 'Authoring checkoutWorkflow: IDE renders initial 2-step graph while live run begins in @siglo/monitor',
        },
        {
            delayCs: 180,
            rightBadge: '🔁 RETRYING (Attempt 2)',
            label: 'Live Graph Update: Adding chargePayment & arrangeShipping hot-reloads IDE; Monitor catches gateway retry',
        },
        {
            delayCs: 180,
            rightBadge: '⚡ WATERFALL (LIVE)',
            label: 'Input Contracts & Waterfall: IDE inspects .spec() rules while chargePayment succeeds on attempt 2 (142ms)',
        },
        {
            delayCs: 180,
            rightBadge: '🚨 SHIPPING FAILED',
            label: 'Downstream Failure: arrangeShipping fails (89ms) — triggering automatic LIFO Saga compensation',
        },
        {
            delayCs: 200,
            rightBadge: '⏪ SAGA REFUND (1/2)',
            label: 'LIFO Saga Rollback (1/2): chargePayment compensation refunds customer payment first (64ms)',
        },
        {
            delayCs: 200,
            rightBadge: '⏪ SAGA COMPLETE (366ms)',
            label: 'LIFO Saga Rollback (2/2): reserveStock compensation releases inventory second (24ms) — zero leaked state',
        },
        {
            delayCs: 190,
            rightBadge: '🔍 DAG DIAGNOSTICS',
            label: 'Telemetry Bridge: Recorded trace imported into IDE inspector alongside @siglo/monitor DAG failure diagnostics',
        },
        {
            delayCs: 190,
            rightBadge: '📜 STATE DIFFS',
            label: 'Full Visibility: Compare all file workflows in IDE while inspecting context state diffs in @siglo/monitor',
        },
    ];

    const frames = [];
    for (let i = 0; i < sceneSpecs.length; i++) {
        const sceneIndex = i + 1;
        const spec = sceneSpecs[i];
        const b64Rgba = await evaluate(`(async () => {
            const loadImg = src => new Promise((res, rej) => {
                const img = new Image();
                img.onload = () => res(img);
                img.onerror = rej;
                img.src = 'data:image/png;base64,' + src;
            });
            const [leftImg, rightImg] = await Promise.all([
                loadImg(${JSON.stringify(leftShots[i])}),
                loadImg(${JSON.stringify(rightShots[i])}),
            ]);
            const canvas = document.getElementById('comp');
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            ctx.fillStyle = '#090d16';
            ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT});

            // Top Split Header (44px)
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, ${WIDTH}, 44);
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, 44);
            ctx.lineTo(${WIDTH}, 44);
            ctx.stroke();

            // Left Header Title
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.arc(20, 22, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#f1f5f9';
            ctx.fillText('IDE Workflow Visualizer (VS Code & IntelliJ)', 34, 27);

            // Auto-Reload Pill
            ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
            ctx.fillRect(508, 11, 118, 22);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
            ctx.strokeRect(508, 11, 118, 22);
            ctx.font = '600 11px monospace';
            ctx.fillStyle = '#34d399';
            ctx.fillText('● Auto-Reload', 520, 26);

            // Right Header Title
            ctx.fillStyle = '#f43f5e';
            ctx.beginPath();
            ctx.arc(660, 22, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#f1f5f9';
            ctx.fillText('@siglo/monitor — Live DevTools & Saga Waterfall', 674, 27);

            // Right Status Pill
            ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
            ctx.fillRect(1080, 11, 186, 22);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
            ctx.strokeRect(1080, 11, 186, 22);
            ctx.font = '600 11px monospace';
            ctx.fillStyle = '#7dd3fc';
            ctx.fillText(${JSON.stringify(spec.rightBadge)}, 1090, 26);

            // Draw Left & Right Panes (y: 44..680, h: 636, w: 639 each)
            ctx.drawImage(leftImg, 0, 44, 639, 636);
            ctx.drawImage(rightImg, 641, 44, 639, 636);

            // Center Divider
            ctx.fillStyle = '#334155';
            ctx.fillRect(639, 0, 2, 680);

            // Bottom Timeline Bar (y: 680..720)
            ctx.fillStyle = '#090d16';
            ctx.fillRect(0, 680, ${WIDTH}, 40);
            ctx.strokeStyle = '#1e293b';
            ctx.beginPath();
            ctx.moveTo(0, 680);
            ctx.lineTo(${WIDTH}, 680);
            ctx.stroke();

            // Scene Step Badge
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(16, 689, 82, 22);
            ctx.font = '700 11px monospace';
            ctx.fillStyle = '#38bdf8';
            ctx.fillText('STEP ' + ${sceneIndex} + '/8', 28, 704);

            // Scene Caption Text
            ctx.font = '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#e2e8f0';
            ctx.fillText(${JSON.stringify(spec.label)}, 112, 705);

            // Progress Bar on Bottom Right
            const barX = 1040;
            const barY = 696;
            const barW = 220;
            const barH = 8;
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(barX, barY, barW, barH);
            const fillW = Math.round((barW * ${sceneIndex}) / 8);
            ctx.fillStyle = '#38bdf8';
            ctx.fillRect(barX, barY, fillW, barH);

            const imgData = ctx.getImageData(0, 0, ${WIDTH}, ${HEIGHT}).data;
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < imgData.length; i += chunk) {
                binary += String.fromCharCode.apply(null, imgData.subarray(i, i + chunk));
            }
            return btoa(binary);
        })()`);

        const rgba = new Uint8Array(Buffer.from(b64Rgba, 'base64'));
        frames.push({ rgba, delayCs: spec.delayCs });
    }

    const outDir = resolve(root, 'docs/assets');
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, 'hero-split-screen.gif');
    const gifBuffer = encodeGif(frames, WIDTH, HEIGHT);
    await writeFile(outPath, gifBuffer);
    console.log(`Wrote ${outPath} (${(gifBuffer.length / 1024).toFixed(1)} KB, ${frames.length} frames, 15.0s loop)`);
} finally {
    socket?.close();
    await monitor.close();
    browser.kill();
    await new Promise(resolveExit => {
        if (browser.exitCode !== null || browser.signalCode !== null) resolveExit();
        else browser.once('exit', resolveExit);
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
