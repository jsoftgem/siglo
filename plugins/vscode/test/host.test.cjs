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
const doc = { uri, languageId: 'typescript', version: 1, getText: () => "const a = Step.create('a', x => x); const f = flow('f').then(a);", offsetAt: p => p.character };
const disposables = [];
const disposable = () => ({ dispose() {} });
const event = name => fn => { handlers[name] = fn; return disposable(); };
class Range {
  constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  contains(p) { const key = x => x.line * 100000 + x.character; return key(p) >= key(this.start) && key(p) <= key(this.end); }
}
const webview = { postMessage: async msg => { messages.push(msg); return true; }, onDidReceiveMessage: fn => { receiver = fn; return disposable(); } };
const vscode = {
  Range, ProgressLocation: { Notification: 15 }, ViewColumn: { One: 1, Beside: -2 },
  workspace: { get isTrusted() { return trusted; }, workspaceFolders: [], getWorkspaceFolder: () => undefined, onDidChangeTextDocument: event('edit'), onDidGrantWorkspaceTrust: event('trust') },
  window: {
    activeTextEditor: { document: doc, selection: { active: { line: 0, character: 12 } } },
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    showWarningMessage: async () => {},
    registerWebviewViewProvider: (_, provider) => { provider.resolveWebviewView({ webview, onDidDispose: event('viewDispose') }); return disposable(); },
    onDidChangeActiveTextEditor: event('active'), onDidChangeTextEditorSelection: event('selection'),
    showTextDocument: async (document, options) => { opened = { document, options }; return { document }; },
  },
  commands: { registerCommand: (name, fn) => { commands[name] = fn; return disposable(); } },
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { activate } = require('../src/extension.ts');
const { secureHtml } = require('../src/webview.ts');
Module._load = originalLoad;
const waitFor = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 20)); }
};

test('CSP blocks network and unapproved scripts while permitting React coordinates', () => {
  const html = secureHtml('<html><head><script type="module">test</script><style>body{}</style></head></html>');
  const nonce = html.match(/script nonce="([^"]+)"/)[1];
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  assert.ok(html.includes(`style-src 'nonce-${nonce}'`));
  assert.ok(html.includes(`style-src-attr 'unsafe-inline'`));
  assert.ok(html.includes(`default-src 'none'`));
  assert.ok(html.includes(`<style nonce="${nonce}"`));
});

test('nonce injection preserves tag-like strings inside JavaScript and CSS', () => {
  const script = 'const scriptTag = "<script>"; const styleTag = "<style>";';
  const style = 'p::before { content: "<script> <style>"; }';
  const html = secureHtml(`<head><script>${script}</script><style>${style}</style></head>`);
  assert.equal(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], script);
  assert.equal(html.match(/<style nonce="[^"]+"[^>]*>([\s\S]*?)<\/style>/)[1], style);
  assert.doesNotThrow(() => new Function(script));
});

test('the real single-file UI remains valid JavaScript after CSP injection', () => {
  const original = readFileSync(path.resolve(__dirname, '../dist/index.html'), 'utf8');
  const secured = secureHtml(original);
  const scripts = html => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts(original).length > 0);
  assert.deepEqual(scripts(secured), scripts(original));
  for (const script of scripts(secured)) assert.doesNotThrow(() => new Function(script));
});

test('host handles ready, trusted launch, live edits, background tabs, and validated navigation', async t => {
  trusted = false;
  activate({ subscriptions: disposables, asAbsolutePath: name => path.resolve(__dirname, '..', name) });
  t.after(() => { for (const d of disposables) d.dispose(); });
  receiver({ type: 'ready' });
  await waitFor(() => messages.some(msg => msg.type === 'setGraph'));
  assert.match(messages.at(-1).document.workflowName, /Trust/);
  trusted = true;
  handlers.trust();
  await waitFor(() => messages.some(msg => msg.document?.nodes.length));
  let graph = messages.filter(msg => msg.document?.nodes.length).at(-1).document;
  assert.equal(graph.documentVersion, 1);
  receiver({ type: 'nodeSelected', nodeId: graph.nodes[0].id, location: { start: { line: 9999 } } });
  await waitFor(() => opened);
  assert.equal(opened.document, doc);
  assert.equal(opened.options.selection.start.line, graph.nodes[0].location.start.line);
  opened = undefined;
  receiver({ type: 'nodeSelected', nodeId: 'forged' });
  assert.equal(opened, undefined);
  doc.version = 2;
  handlers.edit({ document: doc, contentChanges: [{}] });
  await waitFor(() => messages.some(msg => msg.document?.documentVersion === 2));
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
});

test('workspace discovery includes JavaScript and workflows from multiple roots', async () => {
  const firstUri = { scheme: 'file', toString: () => 'file:///root-a/a.ts' };
  const secondUri = { scheme: 'file', toString: () => 'file:///root-b/b.js' };
  let query;
  let options;
  vscode.workspace.findFiles = async (...args) => { query = args; return [firstUri, secondUri]; };
  vscode.workspace.openTextDocument = async uri => ({ ...doc, uri });
  vscode.workspace.asRelativePath = uri => uri.toString().slice('file:///'.length);
  vscode.window.withProgress = async (_, fn) => fn({}, { isCancellationRequested: false });
  vscode.ProgressLocation = { Notification: 15 };
  vscode.window.showQuickPick = async choices => { options = choices; return undefined; };
  vscode.window.showInformationMessage = async () => {};
  const subscriptions = [];
  activate({ subscriptions, asAbsolutePath: name => path.resolve(__dirname, '..', name) });
  try {
    await commands['siglo.discoverWorkflows']();
    assert.equal(query[2], 100);
    assert.match(query[1], /node_modules,dist,.git/);
    assert.deepEqual(options.map(option => option.description), ['root-a/a.ts', 'root-b/b.js']);
  } finally { for (const d of subscriptions) d.dispose(); }
});
