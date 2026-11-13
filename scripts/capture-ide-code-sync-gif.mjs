// Capture a 15-second split-screen looping GIF (docs/assets/ide-code-sync.gif) showing:
// 1. Adding steps in TypeScript code automatically updates the IDE Workflow Visualizer (Auto-Reload)
// 2. Selecting a step node in the IDE Workflow Visualizer jumps to its code definition and opens the related step file
// 3. Moving the cursor in code syncs selection back to the visual inspector
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
// Analyzer Sources for IDE Visualizer (Right Pane)
// ---------------------------------------------------------------------------
const source2Steps = `
import { Step, flow } from '@siglo/core';

const validateOrder = Step.create('validateOrder', async (input: any) => input)
    .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
    .spec('sku', { require: true })
    .spec('amountCents', { validate: (value: number) => value > 0 })
    .timeout(1000);

const reserveStock = Step.create('reserveStock', { retries: 1, timeoutMs: 2000 }, async () => ({}))
    .compensate(async () => {});

export const checkoutWorkflow = flow(validateOrder, reserveStock);
`;

const source4Steps = `
import { Step, flow } from '@siglo/core';
import { httpStep } from '@siglo/http';

const validateOrder = Step.create('validateOrder', async (input: any) => input)
    .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
    .spec('sku', { require: true })
    .spec('amountCents', { validate: (value: number) => value > 0 })
    .timeout(1000);

const reserveStock = Step.create('reserveStock', { retries: 1, timeoutMs: 2000 }, async () => ({}))
    .compensate(async () => {});

const chargePayment = httpStep('chargePayment', {
    method: 'POST',
    url: 'https://api.stripe.com/v1/charges',
    maxRetries: 3,
    timeoutMs: 4000,
}).compensate(async () => {});

const shipOrder = Step.create('shipOrder', { retries: 2, timeoutMs: 3000 }, async () => ({}))
    .compensate(async () => {});

export const checkoutWorkflow = flow(
    validateOrder,
    reserveStock,
    chargePayment,
    shipOrder,
);
`;

const source4StepsWithPolicies = `
import { Step, flow } from '@siglo/core';
import { httpStep } from '@siglo/http';

const validateOrder = Step.create('validateOrder', async (input: any) => input)
    .spec('orderId', { require: true, requireMessage: 'An order ID is required.' })
    .spec('sku', { require: true })
    .spec('amountCents', { validate: (value: number) => value > 0 })
    .timeout(1000);

const reserveStock = Step.create('reserveStock', { retries: 1, timeoutMs: 2000 }, async () => ({}))
    .compensate(async () => {});

const chargePayment = httpStep('chargePayment', {
    method: 'POST',
    url: 'https://api.stripe.com/v1/charges',
    maxRetries: 3,
    timeoutMs: 4000,
}).compensate(async () => {});

const shipOrder = Step.create('shipOrder', { retries: 2, timeoutMs: 3000 }, async () => ({}))
    .compensate(async () => {});

export const checkoutWorkflow = flow(
    validateOrder,
    reserveStock,
    chargePayment,
    shipOrder,
)
    .timeout(15000)
    .version('v1.2')
    .networkPolicy({
        defaultPolicy: 'deny',
        allowedHosts: ['api.stripe.com', 'shipping.internal'],
        allowLocalhost: false,
    });
`;

const graph1 = parseWorkflowFile({
    uri: 'file:///workspace/src/workflows/checkout.workflow.ts',
    content: source2Steps,
    workflowName: 'checkoutWorkflow',
    documentVersion: 1,
});

const graph2 = parseWorkflowFile({
    uri: 'file:///workspace/src/workflows/checkout.workflow.ts',
    content: source4Steps,
    workflowName: 'checkoutWorkflow',
    documentVersion: 2,
});

const graph3 = parseWorkflowFile({
    uri: 'file:///workspace/src/workflows/checkout.workflow.ts',
    content: source4StepsWithPolicies,
    workflowName: 'checkoutWorkflow',
    documentVersion: 3,
});

// ---------------------------------------------------------------------------
// Code Editor File Buffers for Left Pane
// ---------------------------------------------------------------------------
const FILES = {
    'checkout-initial': {
        activeTab: 'workflows/checkout.workflow.ts',
        breadcrumb: 'src › workflows › checkout.workflow.ts › checkoutWorkflow',
        lines: [
            "import { Step, flow } from '@siglo/core';",
            "import { reserveStock } from '../steps/reserve-stock.step';",
            '',
            "export const validateOrder = Step.create('validateOrder', async (order: Order) => order)",
            "    .spec('orderId', { require: true, requireMessage: 'Order ID required' })",
            "    .spec('sku', { require: true })",
            "    .spec('amountCents', { validate: (v: number) => v > 0 })",
            '    .timeout(1000);',
            '',
            '// Compose initial 2-step workflow pipeline',
            'export const checkoutWorkflow = flow(',
            '    validateOrder,',
            '    reserveStock,',
            ');',
        ],
    },
    'checkout-added-steps': {
        activeTab: 'workflows/checkout.workflow.ts',
        breadcrumb: 'src › workflows › checkout.workflow.ts › checkoutWorkflow',
        lines: [
            "import { Step, flow } from '@siglo/core';",
            "import { reserveStock } from '../steps/reserve-stock.step';",
            "import { chargePayment } from '../steps/charge-payment.step';",
            "import { shipOrder } from '../steps/ship-order.step';",
            '',
            "export const validateOrder = Step.create('validateOrder', async (order: Order) => order)",
            "    .spec('orderId', { require: true, requireMessage: 'Order ID required' })",
            "    .spec('sku', { require: true })",
            "    .spec('amountCents', { validate: (v: number) => v > 0 })",
            '    .timeout(1000);',
            '',
            '// Added chargePayment & shipOrder -> IDE Visualizer hot-reloads!',
            'export const checkoutWorkflow = flow(',
            '    validateOrder,',
            '    reserveStock,',
            '    chargePayment,',
            '    shipOrder,',
            ');',
        ],
    },
    'checkout-with-policies': {
        activeTab: 'workflows/checkout.workflow.ts',
        breadcrumb: 'src › workflows › checkout.workflow.ts › checkoutWorkflow',
        lines: [
            "import { Step, flow } from '@siglo/core';",
            "import { reserveStock } from '../steps/reserve-stock.step';",
            "import { chargePayment } from '../steps/charge-payment.step';",
            "import { shipOrder } from '../steps/ship-order.step';",
            '',
            "export const validateOrder = Step.create('validateOrder', async (order: Order) => order)",
            "    .spec('orderId', { require: true, requireMessage: 'Order ID required' })",
            "    .spec('sku', { require: true })",
            "    .spec('amountCents', { validate: (v: number) => v > 0 })",
            '    .timeout(1000);',
            '',
            'export const checkoutWorkflow = flow(',
            '    validateOrder,',
            '    reserveStock,',
            '    chargePayment,',
            '    shipOrder,',
            ')',
            '    .timeout(15000)',
            "    .version('v1.2')",
            '    .networkPolicy({',
            "        defaultPolicy: 'deny',",
            "        allowedHosts: ['api.stripe.com', 'shipping.internal'],",
            '    });',
        ],
    },
    'charge-payment-step': {
        activeTab: 'steps/charge-payment.step.ts',
        breadcrumb: 'src › steps › charge-payment.step.ts › chargePayment',
        lines: [
            "import { httpStep } from '@siglo/http';",
            "import { billingClient } from '../services/billing';",
            '',
            '// Opened automatically when selecting "chargePayment" in Visualizer',
            "export const chargePayment = httpStep('chargePayment', {",
            "    method: 'POST',",
            "    url: 'https://api.stripe.com/v1/charges',",
            '    maxRetries: 3,',
            '    timeoutMs: 4000,',
            '    headers: { "Idempotency-Key": "{{orderId}}" },',
            '})',
            '    .allowNetwork(["api.stripe.com"])',
            '    .compensate(async ctx => {',
            '        // LIFO Saga rollback: refund card if shipping fails',
            '        await billingClient.refundCharge(ctx.paymentId);',
            '    });',
        ],
    },
    'ship-order-step': {
        activeTab: 'steps/ship-order.step.ts',
        breadcrumb: 'src › steps › ship-order.step.ts › shipOrder',
        lines: [
            "import { Step } from '@siglo/core';",
            "import { courierService } from '../services/courier';",
            '',
            '// Opened automatically when selecting "shipOrder" in Visualizer',
            'export const shipOrder = Step.create(',
            "    'shipOrder',",
            '    { retries: 2, timeoutMs: 3000 },',
            '    async ({ orderId, reservationId, paymentId }: ShipInput) => {',
            '        const trackingId = await courierService.dispatch({',
            '            orderId,',
            '            reservationId,',
            '            paymentId,',
            '        });',
            '        return { trackingId };',
            '    },',
            ').compensate(async ctx => {',
            '    await courierService.cancelShipment(ctx.trackingId);',
            '});',
        ],
    },
};

const WIDTH = 1280;
const HEIGHT = 720;

const profile = await mkdtemp(resolve(tmpdir(), 'siglo-ide-sync-gif-'));
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
    // PHASE A: Capture 8 IDE Workflow Visualizer States + Node Coordinates
    // =======================================================================
    const IDE_W = 920;
    const IDE_H = 916;
    await call('Emulation.setDeviceMetricsOverride', {
        width: IDE_W,
        height: IDE_H,
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

    const getNodeCenter = async stepName =>
        evaluate(`(() => {
            const cards = Array.from(document.querySelectorAll('div, button'));
            const match = cards.find(el => {
                const txt = (el.textContent || '').trim();
                return txt.includes(${JSON.stringify(stepName)}) && el.getBoundingClientRect().width > 120 && el.getBoundingClientRect().width < 320 && el.getBoundingClientRect().height > 45 && el.getBoundingClientRect().height < 140;
            });
            if (!match) return null;
            const r = match.getBoundingClientRect();
            return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
        })()`);

    const rightShots = [];
    const clickTargets = [];

    const reserve1 = graph1.nodes.find(n => n.name === 'reserveStock');
    const ship2 = graph2.nodes.find(n => n.name === 'shipOrder');
    const validate3 = graph3.nodes.find(n => n.name === 'validateOrder');
    const charge3 = graph3.nodes.find(n => n.name === 'chargePayment');
    const ship3 = graph3.nodes.find(n => n.name === 'shipOrder');

    // Scene 1: 2-step workflow in IDE
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(graph1)}})`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(reserve1.id)}})`);
    rightShots.push(await grabShot());
    clickTargets.push(null);

    // Scene 2: 4-step workflow hot-reloads in IDE after adding chargePayment & shipOrder in code
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(graph2)}})`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(ship2.id)}})`);
    rightShots.push(await grabShot());
    clickTargets.push(null);

    // Scene 3: Workflow-level policies (.timeout(15000).version('v1.2').networkPolicy(...)) hot-reload in IDE
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'setGraph', document:${JSON.stringify(graph3)}})`);
    await evaluate(`(() => {
        const wfBtn = document.querySelector('[title="Inspect workflow: checkoutWorkflow"]');
        if (wfBtn) wfBtn.click();
    })()`);
    rightShots.push(await grabShot());
    clickTargets.push(null);

    // Scene 4: User clicks `chargePayment` node in IDE Visualizer -> shows click ripple on node
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(charge3.id)}})`);
    rightShots.push(await grabShot());
    clickTargets.push({ ...(await getNodeCenter('chargePayment')), label: 'Click chargePayment' });

    // Scene 5: `steps/charge-payment.step.ts` opens on Left; `chargePayment` inspector open on Right
    rightShots.push(await grabShot());
    clickTargets.push(null);

    // Scene 6: Switch to Run tab and select sequential range (reserveStock -> chargePayment)
    await evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const runTabBtn = btns.find(b => b.textContent && b.textContent.trim() === 'Run');
        if (runTabBtn) runTabBtn.click();
    })()`);
    await evaluate(`(() => {
        const b1 = document.querySelector('button[title="reserveStock"]');
        const b2 = document.querySelector('button[title="chargePayment"]');
        if (b1) b1.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        if (b2) b2.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        const textarea = document.querySelector('textarea#run-input');
        if (textarea) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInputValueSetter.call(textarea, JSON.stringify({ orderId: 'ord_9042', amountCents: 4900 }, null, 2));
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    })()`);
    await settle();
    rightShots.push(await grabShot());
    clickTargets.push({ ...(await getNodeCenter('chargePayment')), label: 'Ctrl+Click to Select Range' });

    // Scene 7: Execute steps 2–3 via isolated runner, showing live progress & Pretty JSON output
    await evaluate(`(() => {
        window.cefQuery = ({ request, onSuccess }) => {
            const req = JSON.parse(request);
            if (req.type === 'runSteps') {
                if (onSuccess) onSuccess('{}');
                setTimeout(() => {
                    window.__SIGLO_BRIDGE__.dispatch({
                        type: 'runEvent',
                        runId: req.runId,
                        status: 'step',
                        nodeId: req.nodeIds[0],
                        output: { reservationId: 'res_ord_9042', status: 'CONFIRMED' }
                    });
                    window.__SIGLO_BRIDGE__.dispatch({
                        type: 'runEvent',
                        runId: req.runId,
                        status: 'step',
                        nodeId: req.nodeIds[1],
                        output: { chargeId: 'ch_9042_live', amount: 4900, status: 'succeeded' }
                    });
                    window.__SIGLO_BRIDGE__.dispatch({
                        type: 'runEvent',
                        runId: req.runId,
                        status: 'completed',
                        elapsedMs: 240,
                        output: { chargeId: 'ch_9042_live', amount: 4900, status: 'succeeded' }
                    });
                }, 50);
            }
        };
        const btns = Array.from(document.querySelectorAll('button'));
        const runActionBtn = btns.find(b => b.textContent && b.textContent.includes('Run steps'));
        if (runActionBtn) runActionBtn.click();
    })()`);
    await new Promise(r => setTimeout(r, 200));
    await settle();
    rightShots.push(await grabShot());
    clickTargets.push(null);

    // Scene 8: Switch back to Inspect tab, cursor inside validateOrder in code editor -> visualizer highlights validateOrder & shows contracts
    await evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const inspectBtn = btns.find(b => b.textContent && b.textContent.trim() === 'Inspect');
        if (inspectBtn) inspectBtn.click();
    })()`);
    await evaluate(`window.__SIGLO_BRIDGE__.dispatch({type:'selectNode', nodeId:${JSON.stringify(validate3.id)}})`);
    rightShots.push(await grabShot());
    clickTargets.push(null);

    console.log('Captured 8 IDE Visualizer states');

    // =======================================================================
    // PHASE B: Composite Left Code Editor + Right IDE Visualizer onto 1280x720
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

    const scenes = [
        {
            delayCs: 180,
            fileKey: 'checkout-initial',
            addedLines: [],
            highlightRange: [11, 14],
            cursorLine: 13,
            navBanner: null,
            rightBadge: '2 steps · Static AST',
            caption:
                '1. Live Code-to-Graph Sync: checkout.workflow.ts defines 2 initial steps (validateOrder -> reserveStock)',
        },
        {
            delayCs: 190,
            fileKey: 'checkout-added-steps',
            addedLines: [3, 4, 16, 17],
            highlightRange: [13, 18],
            cursorLine: 17,
            navBanner: {
                text: '✨ Auto-Reload (250ms): +2 steps added to DAG (chargePayment, shipOrder)',
                color: '#10b981',
            },
            rightBadge: '⚡ +2 Steps Added',
            caption:
                '2. Add Steps in Code: Adding chargePayment & shipOrder immediately hot-reloads the IDE workflow graph',
        },
        {
            delayCs: 180,
            fileKey: 'checkout-with-policies',
            addedLines: [18, 19, 20, 21, 22, 23],
            highlightRange: [18, 23],
            cursorLine: 21,
            navBanner: {
                text: '✨ Auto-Reload: Deadline (15000ms), Version (v1.2) & Network Egress Policy synced',
                color: '#38bdf8',
            },
            rightBadge: '🛡️ Policy Inspector',
            caption:
                '3. Workflow Settings Sync: Chaining .timeout(), .version(), and .networkPolicy() updates the IDE inspector live',
        },
        {
            delayCs: 180,
            fileKey: 'checkout-with-policies',
            addedLines: [],
            highlightRange: [15, 15],
            cursorLine: 15,
            navBanner: {
                text: '🖱️ Clicked "chargePayment" in Visualizer → Navigating to steps/charge-payment.step.ts:5',
                color: '#f59e0b',
            },
            rightBadge: '🖱️ Select Node',
            caption:
                '4. Graph-to-Code Navigation: Clicking "chargePayment" in the visual graph triggers IDE source navigation',
        },
        {
            delayCs: 200,
            fileKey: 'charge-payment-step',
            addedLines: [],
            highlightRange: [5, 16],
            cursorLine: 5,
            navBanner: {
                text: '📂 Opened steps/charge-payment.step.ts (L5:C14 → L16:C6) — HTTP POST & Saga Compensation',
                color: '#38bdf8',
            },
            rightBadge: '📂 Opened Step File',
            caption:
                '5. Opens Related Step File: Editor automatically opens steps/charge-payment.step.ts and highlights the step',
        },
        {
            delayCs: 190,
            fileKey: 'checkout-with-policies',
            addedLines: [],
            highlightRange: [12, 16],
            cursorLine: 14,
            navBanner: {
                text: '▶️ Interactive Runner: Selected sequential step range (reserveStock → chargePayment)',
                color: '#38bdf8',
            },
            rightBadge: '▶️ Range: Steps 2–3',
            caption:
                '6. Run Selected Steps: Switch to Run tab and Ctrl/Cmd-click steps to select a sequential execution range',
        },
        {
            delayCs: 200,
            fileKey: 'checkout-with-policies',
            addedLines: [],
            highlightRange: [14, 16],
            cursorLine: 15,
            navBanner: {
                text: '✨ Isolated Worker: Executed steps 2–3 with project tsx; Pretty JSON output ready',
                color: '#10b981',
            },
            rightBadge: '✅ Output: 200 OK (0.2s)',
            caption:
                '7. Interactive Step Execution: Real-time progress, live step results, and Pretty JSON output without full flow execution',
        },
        {
            delayCs: 190,
            fileKey: 'checkout-with-policies',
            addedLines: [],
            highlightRange: [6, 10],
            cursorLine: 7,
            navBanner: {
                text: '🔄 Bi-Directional Cursor Sync: Cursor in validateOrder highlights node & .spec() contracts',
                color: '#a855f7',
            },
            rightBadge: '📋 Input Contracts',
            caption:
                '8. Bi-Directional Sync: Placing the editor cursor inside validateOrder selects it in the graph & shows contracts',
        },
    ];

    const frames = [];
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const fileData = FILES[scene.fileKey];
        const clickTarget = clickTargets[i];
        const sceneNum = i + 1;

        const b64Rgba = await evaluate(`(async () => {
            const loadImg = src => new Promise((res, rej) => {
                const img = new Image();
                img.onload = () => res(img);
                img.onerror = rej;
                img.src = 'data:image/png;base64,' + src;
            });
            const rightImg = await loadImg(${JSON.stringify(rightShots[i])});
            const canvas = document.getElementById('comp');
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            // Full background
            ctx.fillStyle = '#090d16';
            ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT});

            // ===============================================================
            // TOP SPLIT HEADER (0..44)
            // ===============================================================
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
            ctx.fillText('TypeScript Code Editor (VS Code / IntelliJ IDEA)', 34, 27);

            // Left Sync Pill
            ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
            ctx.fillRect(486, 11, 140, 22);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
            ctx.strokeRect(486, 11, 140, 22);
            ctx.font = '600 11px monospace';
            ctx.fillStyle = '#7dd3fc';
            ctx.fillText('⇄ Bi-Directional', 498, 26);

            // Right Header Title
            ctx.fillStyle = '#10b981';
            ctx.beginPath();
            ctx.arc(660, 22, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#f1f5f9';
            ctx.fillText('Siglo IDE Workflow Visualizer & Step Inspector', 674, 27);

            // Right Status Pill
            ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
            ctx.fillRect(1084, 11, 182, 22);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
            ctx.strokeRect(1084, 11, 182, 22);
            ctx.font = '600 11px monospace';
            ctx.fillStyle = '#34d399';
            ctx.fillText(${JSON.stringify(scene.rightBadge)}, 1096, 26);

            // ===============================================================
            // LEFT PANE: IDE CODE EDITOR (x: 0..639, y: 44..680)
            // ===============================================================
            const edX = 0;
            const edY = 44;
            const edW = 639;
            const edH = 636;
            ctx.fillStyle = '#141720';
            ctx.fillRect(edX, edY, edW, edH);

            // 1. Editor Tabs Bar (y: 44..80)
            ctx.fillStyle = '#0d1017';
            ctx.fillRect(edX, edY, edW, 36);
            const tabs = [
                'workflows/checkout.workflow.ts',
                'steps/charge-payment.step.ts',
                'steps/ship-order.step.ts',
            ];
            let tabX = 8;
            const activeTab = ${JSON.stringify(fileData.activeTab)};
            for (const tab of tabs) {
                const isActive = tab === activeTab;
                const tw = tab.length * 6.8 + 28;
                ctx.fillStyle = isActive ? '#181c27' : '#11151f';
                ctx.fillRect(tabX, edY + 4, tw, 32);
                if (isActive) {
                    ctx.fillStyle = '#38bdf8';
                    ctx.fillRect(tabX, edY + 4, tw, 2);
                }
                ctx.font = '600 10.5px monospace';
                ctx.fillStyle = isActive ? '#38bdf8' : '#64748b';
                ctx.fillText('TS', tabX + 8, edY + 24);
                ctx.font = (isActive ? '600 ' : '400 ') + '11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                ctx.fillStyle = isActive ? '#f8fafc' : '#94a3b8';
                ctx.fillText(tab, tabX + 26, edY + 24);
                tabX += tw + 4;
            }

            // 2. Breadcrumb Bar (y: 80..104)
            ctx.fillStyle = '#181c27';
            ctx.fillRect(edX, edY + 36, edW, 24);
            ctx.strokeStyle = '#222838';
            ctx.beginPath();
            ctx.moveTo(edX, edY + 60);
            ctx.lineTo(edX + edW, edY + 60);
            ctx.stroke();
            ctx.font = '500 11px monospace';
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(${JSON.stringify(fileData.breadcrumb)}, 14, edY + 52);

            // 3. Optional Navigation / Auto-Reload Banner (y: 104..134)
            const navBanner = ${JSON.stringify(scene.navBanner)};
            let codeStartY = edY + 74;
            if (navBanner) {
                ctx.fillStyle = 'rgba(30, 41, 59, 0.95)';
                ctx.fillRect(10, edY + 66, edW - 20, 26);
                ctx.strokeStyle = navBanner.color;
                ctx.lineWidth = 1;
                ctx.strokeRect(10, edY + 66, edW - 20, 26);
                ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                ctx.fillStyle = '#f8fafc';
                ctx.fillText(navBanner.text, 20, edY + 83);
                codeStartY = edY + 108;
            }

            // 4. Syntax-Highlighted Code Lines
            const lines = ${JSON.stringify(fileData.lines)};
            const addedSet = new Set(${JSON.stringify(scene.addedLines)});
            const [hlStart, hlEnd] = ${JSON.stringify(scene.highlightRange)};
            const cursorLine = ${JSON.stringify(scene.cursorLine)};
            const lineH = 22;

            const drawSyntaxLine = (text, x, y) => {
                if (text.trim().startsWith('//')) {
                    ctx.fillStyle = '#64748b';
                    ctx.fillText(text, x, y);
                    return;
                }
                const tokenRegex = /('[^']*'|"[^"]*"|\\b(?:import|from|export|const|async|return|await)\\b|\\b(?:Step|flow|httpStep|validateOrder|reserveStock|chargePayment|shipOrder|checkoutWorkflow)\\b|\\b(?:create|spec|timeout|compensate|version|networkPolicy|allowNetwork|refundCharge|dispatch|cancelShipment)\\b|\\b\\d+\\b)/g;
                let lastIdx = 0;
                let curX = x;
                let match;
                while ((match = tokenRegex.exec(text)) !== null) {
                    if (match.index > lastIdx) {
                        const plain = text.slice(lastIdx, match.index);
                        ctx.fillStyle = '#e2e8f0';
                        ctx.fillText(plain, curX, y);
                        curX += ctx.measureText(plain).width;
                    }
                    const tok = match[0];
                    if (tok.startsWith("'") || tok.startsWith('"')) {
                        ctx.fillStyle = '#86efac';
                    } else if (/^(import|from|export|const|async|return|await)$/.test(tok)) {
                        ctx.fillStyle = '#c084fc';
                    } else if (/^(Step|flow|httpStep|validateOrder|reserveStock|chargePayment|shipOrder|checkoutWorkflow)$/.test(tok)) {
                        ctx.fillStyle = '#38bdf8';
                    } else if (/^\\d+$/.test(tok)) {
                        ctx.fillStyle = '#fbbf24';
                    } else {
                        ctx.fillStyle = '#93c5fd';
                    }
                    ctx.fillText(tok, curX, y);
                    curX += ctx.measureText(tok).width;
                    lastIdx = tokenRegex.lastIndex;
                }
                if (lastIdx < text.length) {
                    ctx.fillStyle = '#e2e8f0';
                    ctx.fillText(text.slice(lastIdx), curX, y);
                }
            };

            ctx.font = '500 12px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
            for (let idx = 0; idx < lines.length; idx++) {
                const lineNum = idx + 1;
                const yTop = codeStartY + idx * lineH;
                const yText = yTop + 15;
                const isAdded = addedSet.has(lineNum);
                const isHighlighted = lineNum >= hlStart && lineNum <= hlEnd;

                if (isAdded) {
                    ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
                    ctx.fillRect(0, yTop, edW, lineH);
                    ctx.fillStyle = '#10b981';
                    ctx.fillRect(0, yTop, 4, lineH);
                } else if (isHighlighted) {
                    ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
                    ctx.fillRect(0, yTop, edW, lineH);
                    ctx.fillStyle = '#38bdf8';
                    ctx.fillRect(0, yTop, 3, lineH);
                }

                ctx.fillStyle = isHighlighted || isAdded ? '#e2e8f0' : '#475569';
                ctx.fillText(String(lineNum).padStart(2, ' '), 14, yText);

                if (isAdded) {
                    ctx.fillStyle = '#34d399';
                    ctx.fillText('+', 34, yText);
                }

                drawSyntaxLine(lines[idx], 48, yText);

                if (lineNum === cursorLine) {
                    const lineW = ctx.measureText(lines[idx]).width;
                    ctx.fillStyle = '#38bdf8';
                    ctx.fillRect(48 + lineW + 2, yTop + 3, 2, lineH - 6);
                }
            }

            // ===============================================================
            // RIGHT PANE: IDE WORKFLOW VISUALIZER (x: 641..1280, y: 44..680)
            // ===============================================================
            ctx.drawImage(rightImg, 641, 44, 639, 636);

            // Optional Click Ripple + Pointer on Visualizer Node
            const clickInfo = ${JSON.stringify(clickTarget)};
            if (clickInfo && clickInfo.x && clickInfo.y) {
                const scaleX = 639 / ${IDE_W};
                const scaleY = 636 / ${IDE_H};
                const cx = 641 + clickInfo.x * scaleX;
                const cy = 44 + clickInfo.y * scaleY;

                ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(cx, cy, 24, 0, Math.PI * 2);
                ctx.stroke();

                ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
                ctx.beginPath();
                ctx.arc(cx, cy, 14, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#0f172a';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx + 14, cy + 6);
                ctx.lineTo(cx + 8, cy + 9);
                ctx.lineTo(cx + 12, cy + 17);
                ctx.lineTo(cx + 8, cy + 19);
                ctx.lineTo(cx + 4, cy + 11);
                ctx.lineTo(cx, cy + 16);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                const pillW = 195;
                const pillH = 24;
                const px = Math.min(cx + 22, 1280 - pillW - 10);
                const py = Math.max(cy - 12, 54);
                ctx.fillStyle = '#0f172a';
                ctx.fillRect(px, py, pillW, pillH);
                ctx.strokeStyle = '#38bdf8';
                ctx.strokeRect(px, py, pillW, pillH);
                ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                ctx.fillStyle = '#38bdf8';
                ctx.fillText('🖱️ ' + clickInfo.label + ' → Open Code', px + 8, py + 16);
            }

            // Center Divider
            ctx.fillStyle = '#334155';
            ctx.fillRect(639, 0, 2, 680);

            // ===============================================================
            // BOTTOM TIMELINE BAR (y: 680..720)
            // ===============================================================
            ctx.fillStyle = '#090d16';
            ctx.fillRect(0, 680, ${WIDTH}, 40);
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, 680);
            ctx.lineTo(${WIDTH}, 680);
            ctx.stroke();

            ctx.fillStyle = '#1e293b';
            ctx.fillRect(16, 689, 82, 22);
            ctx.font = '700 11px monospace';
            ctx.fillStyle = '#38bdf8';
            ctx.fillText('STEP ' + ${sceneNum} + '/8', 28, 704);

            ctx.font = '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#e2e8f0';
            ctx.fillText(${JSON.stringify(scene.caption)}, 112, 705);

            const barX = 1040;
            const barY = 696;
            const barW = 220;
            const barH = 8;
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(barX, barY, barW, barH);
            const fillW = Math.round((barW * ${sceneNum}) / 8);
            ctx.fillStyle = '#10b981';
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
        frames.push({ rgba, delayCs: scene.delayCs });
    }

    const outDir = resolve(root, 'docs/assets');
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, 'ide-code-sync.gif');
    const gifBuffer = encodeGif(frames, WIDTH, HEIGHT);
    await writeFile(outPath, gifBuffer);
    console.log(`Wrote ${outPath} (${(gifBuffer.length / 1024).toFixed(1)} KB, ${frames.length} frames, 15.0s loop)`);
} finally {
    socket?.close();
    browser.kill();
    await new Promise(resolveExit => {
        if (browser.exitCode !== null || browser.signalCode !== null) resolveExit();
        else browser.once('exit', resolveExit);
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
