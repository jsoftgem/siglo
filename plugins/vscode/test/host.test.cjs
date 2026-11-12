require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const handlers = {};
const commands = {};
const messages = [];
let receiver;
let opened;
let trusted = true;
const uri = { scheme: 'file', toString: () => 'file:///tmp/test.ts' };
const doc = {
    uri,
    languageId: 'typescript',
    version: 1,
    getText: () => "const a = Step.create('a', x => x); const f = flow('f').then(a);",
    offsetAt: p => p.character,
};
const disposables = [];
const disposable = () => ({ dispose() {} });
const event = name => fn => {
    handlers[name] = fn;
    return disposable();
};

const diagnosticsMap = new Map();
class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
        this.code = undefined;
        this.source = undefined;
    }
}
class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}
class Range {
    constructor(sl, sc, el, ec) {
        if (typeof sl === 'object') {
            this.start = sl;
            this.end = sc;
        } else {
            this.start = { line: sl, character: sc };
            this.end = { line: el, character: ec };
        }
    }
    contains(p) {
        const key = x => x.line * 100000 + x.character;
        return key(p) >= key(this.start) && key(p) <= key(this.end);
    }
}
const webview = {
    postMessage: async msg => {
        messages.push(msg);
        return true;
    },
    onDidReceiveMessage: fn => {
        receiver = fn;
        return disposable();
    },
};
const vscode = {
    Range,
    Position,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
        createDiagnosticCollection: name => ({
            name,
            set: (u, diags) => diagnosticsMap.set(u.toString(), diags),
            get: u => diagnosticsMap.get(u.toString()) || [],
            delete: u => diagnosticsMap.delete(u.toString()),
            clear: () => diagnosticsMap.clear(),
            dispose: () => diagnosticsMap.clear(),
        }),
    },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { One: 1, Beside: -2 },
    workspace: {
        get isTrusted() {
            return trusted;
        },
        workspaceFolders: [],
        getWorkspaceFolder: () => undefined,
        fs: {
            readFile: async u => readFileSync(u.fsPath || u.path),
        },
        onDidChangeTextDocument: event('edit'),
        onDidGrantWorkspaceTrust: event('trust'),
        onDidCloseTextDocument: event('close'),
    },
    window: {
        activeTextEditor: { document: doc, selection: { active: { line: 0, character: 12 } } },
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        showWarningMessage: async () => {},
        showInformationMessage: async () => {},
        showErrorMessage: async () => {},
        showOpenDialog: async () => [
            {
                scheme: 'file',
                fsPath: path.resolve(__dirname, '../../../fixtures/telemetry/sample-order-recording.json'),
                path: '/fixtures/telemetry/sample-order-recording.json',
            },
        ],
        registerWebviewViewProvider: (_, provider) => {
            provider.resolveWebviewView({ webview, onDidDispose: event('viewDispose') });
            return disposable();
        },
        onDidChangeActiveTextEditor: event('active'),
        onDidChangeTextEditorSelection: event('selection'),
        showTextDocument: async (document, options) => {
            opened = { document, options };
            return { document };
        },
    },
    commands: {
        registerCommand: (name, fn) => {
            commands[name] = fn;
            return disposable();
        },
    },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
    if (name === 'vscode') return vscode;
    return originalLoad.call(this, name, ...args);
};

const { activate } = require('../src/extension.ts');

function waitFor(condition, timeoutMs = 4000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        function check() {
            if (condition()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('Timed out'));
            setTimeout(check, 10);
        }
        check();
    });
}

test('host handles ready, trusted launch, live edits, background tabs, and validated navigation', async () => {
    trusted = true;
    const subscriptions = [];
    activate({ subscriptions, asAbsolutePath: name => path.resolve(__dirname, '..', name) });
    try {
        await receiver({ type: 'ready' });
        await waitFor(() => messages.some(msg => msg.document));
        const initial = messages.filter(msg => msg.document).at(-1);
        const graph = initial.document;
        const firstNode = graph.nodes[0];
        receiver({ type: 'nodeSelected', nodeId: firstNode.id });
        await waitFor(() => opened);
        assert.equal(opened.document, doc);
        assert.equal(opened.options.selection.start.line, graph.location.start.line);
        opened = undefined;
        receiver({ type: 'openRelatedFile', uri: 'file:///etc/passwd' });
        await new Promise(r => setTimeout(r, 50));
        assert.equal(opened, undefined);
        const originalText = doc.getText;
        doc.getText = () => '\n\n' + originalText();
        doc.version = 2;
        handlers.edit({ document: doc, contentChanges: [{}] });
        await waitFor(() => messages.some(msg => msg.document?.documentVersion === 2));
        const updated = messages.filter(msg => msg.document?.documentVersion === 2).at(-1).document;
        const movedNode = updated.nodes.find(node => node.name === firstNode.name);
        assert.equal(movedNode.location.start.line, firstNode.location.start.line + 2);
        opened = undefined;
        receiver({ type: 'nodeSelected', nodeId: movedNode.id });
        await waitFor(() => opened);
        assert.equal(opened.options.selection.start.line, movedNode.location.start.line);
        doc.getText = originalText;
        const count = messages.length;
        handlers.edit({ document: { ...doc }, contentChanges: [{}] });
        await new Promise(r => setTimeout(r, 300));
        assert.equal(messages.length, count);
        receiver({ type: 'setAutoReload', enabled: false });
        doc.version = 3;
        handlers.edit({ document: doc, contentChanges: [{}] });
        await new Promise(r => setTimeout(r, 400));
        assert.equal(messages.filter(msg => msg.document).at(-1).document.documentVersion, 2);
        receiver({ type: 'reload' });
        await waitFor(() => messages.some(msg => msg.document?.documentVersion === 3));
        doc.version = 4;
        handlers.edit({ document: doc, contentChanges: [{}] });
        const other = { ...doc, uri: { scheme: 'file', toString: () => 'file:///tmp/other.ts' } };
        handlers.active({ document: other });
        await waitFor(() => messages.some(msg => msg.document?.uri === 'file:///tmp/other.ts'));
        await new Promise(r => setTimeout(r, 350));
        assert.equal(messages.filter(msg => msg.document).at(-1).document.uri, 'file:///tmp/other.ts');
    } finally {
        for (const d of subscriptions) d.dispose();
    }
});

test('workspace discovery includes JavaScript and workflows from multiple roots', async () => {
    const firstUri = { scheme: 'file', toString: () => 'file:///root-a/a.ts' };
    const secondUri = { scheme: 'file', toString: () => 'file:///root-b/b.js' };
    let query;
    let options;
    vscode.workspace.findFiles = async (...args) => {
        query = args;
        return [firstUri, secondUri];
    };
    vscode.workspace.openTextDocument = async uri => ({ ...doc, uri });
    vscode.workspace.asRelativePath = uri => uri.toString().slice('file:///'.length);
    vscode.window.withProgress = async (_, fn) => fn({}, { isCancellationRequested: false });
    vscode.ProgressLocation = { Notification: 15 };
    vscode.window.showQuickPick = async choices => {
        options = choices;
        return undefined;
    };
    vscode.window.showInformationMessage = async () => {};
    const subscriptions = [];
    activate({ subscriptions, asAbsolutePath: name => path.resolve(__dirname, '..', name) });
    try {
        await commands['siglo.discoverWorkflows']();
        assert.equal(query[2], 100);
        assert.match(query[1], /node_modules,dist,.git/);
        assert.deepEqual(
            options.map(option => option.description),
            ['root-a/a.ts', 'root-b/b.js'],
        );
    } finally {
        for (const d of subscriptions) d.dispose();
    }
});

test('M2: host surfaces static diagnostics into DiagnosticCollection with precise ranges', async t => {
    trusted = true;
    const subscriptions = [];
    activate({ subscriptions, asAbsolutePath: name => path.resolve(__dirname, '..', name) });
    t.after(() => {
        for (const d of subscriptions) d.dispose();
    });
    const diagDoc = {
        uri: { scheme: 'file', toString: () => 'file:///tmp/diag-test.ts' },
        languageId: 'typescript',
        version: 1,
        getText: () =>
            [
                "import { flow, Step } from '@siglo/core';",
                "const stepA1 = Step.create('dupStep', () => {});",
                "const stepA2 = Step.create('dupStep', () => {});",
                "export const duplicateFlow = flow('duplicateFlow', stepA1, stepA2);",
            ].join('\n'),
        offsetAt: p => p.character,
    };
    handlers.active({ document: diagDoc });
    await waitFor(() => (diagnosticsMap.get('file:///tmp/diag-test.ts') || []).length > 0);
    const diags = diagnosticsMap.get('file:///tmp/diag-test.ts');
    assert.equal(diags.length, 2);
    assert.equal(diags[0].code, 'SIGLO_DUPLICATE_STEP_ID');
    assert.equal(diags[0].source, 'Siglo');
    assert.equal(diags[0].severity, 0);
    assert.ok(diags[0].range.start.line >= 0);
});

test('M4: host imports and sanitizes telemetry recording JSON and posts to webview', async t => {
    trusted = true;
    const subscriptions = [];
    activate({ subscriptions, asAbsolutePath: name => path.resolve(__dirname, '..', name) });
    t.after(() => {
        for (const d of subscriptions) d.dispose();
    });
    await receiver({ type: 'ready' });
    const msgCountBefore = messages.length;
    await commands['siglo.importTelemetry']();
    await waitFor(() => messages.slice(msgCountBefore).some(m => m.type === 'setTelemetry'));
    const telemetryMsg = messages.slice(msgCountBefore).find(m => m.type === 'setTelemetry');
    assert.ok(telemetryMsg, 'Expected setTelemetry message to be dispatched to webview');
    assert.equal(telemetryMsg.document.version, 1);
    assert.equal(telemetryMsg.document.records.length, 4);

    // Fail-closed redaction: URL must be origin-only
    const httpRecord = telemetryMsg.document.records.find(r => r.inspection.kind === 'http');
    assert.ok(httpRecord);
    assert.equal(httpRecord.inspection.url, 'https://api.stripe.com');
    assert.equal(httpRecord.inspection.method, 'POST');
    assert.equal(httpRecord.inspection.status, 200);

    // Crypto record verification category
    const cryptoRecord = telemetryMsg.document.records.find(r => r.inspection.kind === 'crypto');
    assert.ok(cryptoRecord);
    assert.equal(cryptoRecord.inspection.category, 'verified');
    assert.equal(cryptoRecord.inspection.timestampCheck, 'passed');
    assert.equal(cryptoRecord.inspection.replayCheck, 'passed');
});
