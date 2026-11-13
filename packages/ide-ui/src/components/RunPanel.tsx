import { useEffect, useRef, useState } from 'react';
import { executionRange, type GraphDocument, type GraphNode, type GraphEdge, type RunEvent } from '@siglo/ide-protocol';
import { bridge } from '../bridge';

export function RunPanel({
    document,
    workflowName,
    nodes,
    edges,
    selected,
    allFlows,
}: {
    document: GraphDocument;
    workflowName: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    selected: string[];
    allFlows: boolean;
}) {
    const [inputs, setInputs] = useState<Record<string, string>>({});
    const key = `${document.uri}#${workflowName}`;
    const input = inputs[key] ?? '{}';
    const [pretty, setPretty] = useState(true);
    const [events, setEvents] = useState<RunEvent[]>([]);
    const [busy, setBusy] = useState(false);
    const [resultKey, setResultKey] = useState('final');
    const [elapsed, setElapsed] = useState(0);
    const run = useRef<{ id: string; key: string; version: number; started: number }>();
    useEffect(
        () =>
            bridge.subscribe(message => {
                if (message.type !== 'runEvent' || message.runId !== run.current?.id) return;
                setEvents(previous => {
                    const next = [...previous, message];
                    const logs = next.filter(event => event.status === 'log');
                    return next.filter(event => event.status !== 'log' || logs.indexOf(event) >= logs.length - 100);
                });
                if (['completed', 'failed', 'cancelled'].includes(message.status)) {
                    setBusy(false);
                    setElapsed(message.elapsedMs ?? Date.now() - run.current.started);
                }
            }),
        [],
    );
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => setElapsed(Date.now() - (run.current?.started ?? Date.now())), 100);
        return () => clearInterval(timer);
    }, [busy]);
    let validation = '',
        parsed: unknown,
        range: GraphNode[] = [];
    try {
        parsed = JSON.parse(input);
        if (allFlows) throw new Error('Choose one workflow before running steps.');
        range = executionRange(nodes, edges, selected);
    } catch (error) {
        validation = (error as Error).message;
    }
    const start = async () => {
        if (validation || busy) return;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        run.current = { id, key, version: document.documentVersion, started: Date.now() };
        setEvents([]);
        setElapsed(0);
        setBusy(true);
        setResultKey('final');
        try {
            if (!window.cefQuery && !window.acquireVsCodeApi) throw new Error('Execution requires an IDE host.');
            await bridge.sendToHost({
                type: 'runSteps',
                runId: id,
                uri: document.uri,
                documentVersion: document.documentVersion,
                workflowName,
                nodeIds: selected,
                input: parsed,
            });
        } catch (error) {
            setBusy(false);
            setEvents([{ type: 'runEvent', runId: id, status: 'failed', error: String(error) }]);
        }
    };
    const completed = events.filter(
        event => event.status === 'step' && Object.prototype.hasOwnProperty.call(event, 'output'),
    );
    const outputs = [...new Map(completed.map(event => [event.nodeId, event])).values()];
    const final = events.find(event => event.status === 'completed');
    const shown =
        resultKey === 'final'
            ? (final ?? outputs[outputs.length - 1])
            : outputs.find(event => event.nodeId === resultKey);
    const text =
        shown && Object.prototype.hasOwnProperty.call(shown, 'output')
            ? JSON.stringify(shown.output, null, pretty ? 2 : undefined)
            : '';
    const error = events.find(event => event.status === 'failed')?.error;
    const stale = run.current && (run.current.key !== key || run.current.version !== document.documentVersion);
    const status = events.filter(event => event.status !== 'log').slice(-1)[0]?.status;
    const currentStepEvent = events.filter(e => e.status === 'step').slice(-1)[0];
    const progressNodes =
        range.length > 0
            ? range
            : [...new Set(events.filter(event => event.nodeId).map(event => event.nodeId!))].map(
                  id => nodes.find(n => n.id === id) || ({ id, name: id } as GraphNode),
              );
    const control =
        'rounded border border-[#555] bg-[#393b40] px-2 py-1 disabled:opacity-40 hover:bg-[#4a4d52] transition-colors';
    const activeControl =
        'rounded border border-[#3574f0] bg-[#3574f0]/20 text-sky-300 font-medium px-2 py-1 transition-colors';
    const buttonLabel = (() => {
        if (range.length === 0) return 'Run step';
        const firstIdx = range[0].executionTarget?.stepIndex;
        const lastIdx = range[range.length - 1].executionTarget?.stepIndex;
        if (firstIdx !== undefined && lastIdx !== undefined) {
            return range.length > 1 ? `Run steps ${firstIdx + 1}–${lastIdx + 1}` : `Run step ${firstIdx + 1}`;
        }
        return range.length > 1 ? `Run ${range.length} steps` : 'Run step';
    })();

    return (
        <div className="p-3 flex flex-col gap-3 text-xs select-text overflow-auto h-full">
            <p>Runs real project code. Ctrl/Cmd-click steps to select a range.</p>
            <p className="text-sky-300">
                {range.length ? range.map(node => node.name).join(' → ') : 'Select steps in the graph'}
            </p>
            <label htmlFor="run-input">Input JSON</label>
            <textarea
                id="run-input"
                spellCheck={false}
                className="min-h-36 w-full bg-[#1e1f22] border border-[#555] rounded p-2 font-mono"
                value={input}
                onChange={event => setInputs(previous => ({ ...previous, [key]: event.target.value }))}
            />
            <div className="flex gap-2">
                <button
                    className={control}
                    onClick={() => {
                        try {
                            setInputs(previous => ({ ...previous, [key]: JSON.stringify(JSON.parse(input), null, 2) }));
                        } catch {
                            /* Inline error below. */
                        }
                    }}
                >
                    Format
                </button>
                <button className={control} disabled={!!validation || busy} onClick={start}>
                    {buttonLabel}
                </button>
                <button
                    className={control}
                    disabled={!busy}
                    onClick={() => bridge.sendToHost({ type: 'cancelRun', runId: run.current?.id })}
                >
                    Cancel
                </button>
            </div>
            {validation && (
                <p role="alert" className="text-amber-300">
                    {validation}
                </p>
            )}
            <p role="status">
                {busy ? 'Running' : status || 'Ready'} · {(elapsed / 1000).toFixed(1)}s
            </p>
            <ul
                aria-label="Step progress"
                className="divide-y divide-[#393b40]/50 border border-[#393b40] rounded p-2 bg-[#232529]"
            >
                {progressNodes.map(node => {
                    const isCompleted = outputs.some(event => event.nodeId === node.id);
                    const isCurrent = busy && currentStepEvent?.nodeId === node.id;
                    const isFailed = !busy && error && currentStepEvent?.nodeId === node.id;
                    const isCancelled = !busy && status === 'cancelled' && !isCompleted;
                    const stateLabel = isCompleted
                        ? 'Completed'
                        : isCurrent
                          ? 'Running...'
                          : isFailed
                            ? 'Failed'
                            : isCancelled
                              ? 'Cancelled'
                              : busy
                                ? 'Pending'
                                : 'Ready';
                    const colorClass = isCompleted
                        ? 'text-emerald-400'
                        : isCurrent
                          ? 'text-sky-400'
                          : isFailed
                            ? 'text-red-400'
                            : isCancelled
                              ? 'text-amber-400'
                              : 'text-[#8c8c8c]';
                    return (
                        <li key={node.id} className="flex justify-between items-center py-1">
                            <span className="truncate pr-2">{node.name}</span>
                            <span className={`text-[11px] font-mono ${colorClass}`}>{stateLabel}</span>
                        </li>
                    );
                })}
            </ul>
            {stale && (
                <p className="text-amber-300">Results belong to an earlier source revision or another workflow.</p>
            )}
            {error && (
                <pre role="alert" className="whitespace-pre-wrap text-red-300">
                    {error}
                </pre>
            )}
            {status === 'cancelled' && <p>Cancelled. Completed external effects are not undone.</p>}
            <label htmlFor="run-output">Output</label>
            <select
                id="run-output"
                className="bg-[#393b40] p-1 rounded border border-[#555]"
                value={resultKey}
                onChange={event => setResultKey(event.target.value)}
            >
                <option value="final">Final output</option>
                {outputs.map(event => (
                    <option key={event.nodeId} value={event.nodeId}>
                        {nodes.find(node => node.id === event.nodeId)?.name || event.nodeId}
                    </option>
                ))}
            </select>
            <div className="flex gap-2">
                <button
                    className={pretty ? activeControl : control}
                    aria-pressed={pretty}
                    onClick={() => setPretty(true)}
                >
                    Pretty JSON
                </button>
                <button
                    className={!pretty ? activeControl : control}
                    aria-pressed={!pretty}
                    onClick={() => setPretty(false)}
                >
                    Raw JSON
                </button>
                <button
                    className={control}
                    disabled={!text}
                    onClick={() => bridge.sendToHost({ type: 'copyRunOutput', text })}
                >
                    Copy
                </button>
            </div>
            <pre className="min-h-36 whitespace-pre-wrap break-all bg-[#1e1f22] border border-[#555] rounded p-2">
                {text || 'No output yet.'}
            </pre>
            <details>
                <summary className="cursor-pointer text-[#8c8c8c] hover:text-[#bcbec4]">Application logs</summary>
                <pre className="whitespace-pre-wrap break-all mt-1 bg-[#1e1f22] p-2 rounded border border-[#393b40] font-mono text-[11px]">
                    {events
                        .filter(event => event.status === 'log')
                        .map(event => event.log)
                        .join('')
                        .slice(-100000)}
                </pre>
            </details>
        </div>
    );
}
