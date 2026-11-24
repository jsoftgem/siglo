import { applyWaitEvent } from '../../../src/wait-state';
import { appendInspection } from './inspectionUpdates';
import { useState, useEffect, useRef, useCallback } from 'react';
import { WorkflowRun, MonitoringEvent, WorkflowStatus } from '../types';
import { fetchWorkflows } from '../api/workflowApi';
import { SIGLO_EVENT_TYPES } from '../constants/events';

const EVENT_TYPE_SET = new Set<string>(SIGLO_EVENT_TYPES);

function isMonitoringEvent(value: unknown): value is MonitoringEvent {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.type === 'string' && EVENT_TYPE_SET.has(record.type);
}

function isWorkflowStatus(status: unknown): status is WorkflowStatus {
    return (
        status === 'RUNNING' ||
        status === 'COMPLETED' ||
        status === 'FAILED' ||
        status === 'SUSPENDED' ||
        status === 'SKIPPED'
    );
}

interface UseWorkflowMonitorOptions {
    namespace?: string;
    maxEvents?: number;
}

export interface UseWorkflowMonitorResult {
    workflows: Record<string, WorkflowRun>;
    events: MonitoringEvent[];
    isConnected: boolean;
    refresh: () => Promise<void>;
}

export function useWorkflowMonitor({
    namespace = '',
    maxEvents = 500,
}: UseWorkflowMonitorOptions = {}): UseWorkflowMonitorResult {
    const [workflows, setWorkflows] = useState<Record<string, WorkflowRun>>({});
    const [events, setEvents] = useState<MonitoringEvent[]>([]);
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const eventSourceRef = useRef<EventSource | null>(null);

    const loadWorkflows = useCallback(async () => {
        try {
            const list = await fetchWorkflows(namespace || undefined);
            const map: Record<string, WorkflowRun> = {};
            list.forEach(run => {
                map[run.stackId] = run;
            });
            setWorkflows(prev => {
                if (!namespace) {
                    return { ...prev, ...map };
                }
                const filteredPrev: Record<string, WorkflowRun> = {};
                for (const [id, r] of Object.entries(prev)) {
                    if (!r.namespace || r.namespace === namespace) {
                        filteredPrev[id] = r;
                    }
                }
                return { ...filteredPrev, ...map };
            });
        } catch (err) {
            console.error('Failed to load workflows:', err);
        }
    }, [namespace]);

    const handleIncomingEvent = useCallback(
        (ev: MonitoringEvent) => {
            if (namespace && ev.namespace && ev.namespace !== namespace) {
                return;
            }

            setEvents(prev => [ev, ...prev].slice(0, maxEvents));

            const stackId = ev.stackId;
            if (!stackId) return;

            setWorkflows(prev => {
                const existing = prev[stackId] || {
                    stackId,
                    namespace: ev.namespace,
                    status: 'RUNNING',
                    startTime: ev.timestamp ?? Date.now(),
                    steps: {},
                    context: {},
                    contextDiffs: [],
                };

                const updated = { ...existing };

                switch (ev.type) {
                    case 'branch:selected':
                        if (ev.stepId) {
                            const step = updated.steps[ev.stepId] || {
                                stepId: ev.stepId,
                                stepName: ev.stepName,
                                status: 'PENDING' as const,
                            };
                            updated.steps = { ...updated.steps, [ev.stepId]: { ...step, selectedRoute: ev.route } };
                        }
                        break;
                    case 'flow:start':
                        updated.flowName = ev.flowName || updated.flowName;
                        updated.ast = updated.ast || ev.ast;
                        updated.status = 'RUNNING';
                        break;
                    case 'flow:complete':
                        updated.status = isWorkflowStatus(ev.status) ? ev.status : 'COMPLETED';
                        updated.durationMs = ev.durationMs;
                        break;
                    case 'flow:error':
                        updated.status = 'FAILED';
                        break;
                    case 'flow:suspended': {
                        updated.status = 'SUSPENDED';
                        updated.waitingForEvent = ev.waitingForEvent;
                        updated.steps = applyWaitEvent(updated.steps, ev);
                        break;
                    }
                    case 'flow:resumed': {
                        updated.status = 'RUNNING';
                        updated.waitingForEvent = null;
                        updated.steps = applyWaitEvent(updated.steps, ev);
                        break;
                    }
                    case 'step:inspection':
                    case 'ai:complete':
                        if (ev.stepId && ev.inspection) {
                            const step = updated.steps[ev.stepId] || {
                                stepId: ev.stepId,
                                stepName: ev.stepName,
                                status: 'PENDING' as const,
                            };
                            updated.steps = { ...updated.steps, [ev.stepId]: appendInspection(step, ev) };
                        }
                        break;
                    case 'step:start':
                        if (ev.stepId) {
                            const step = updated.steps[ev.stepId] || {};
                            updated.steps = {
                                ...updated.steps,
                                [ev.stepId]: {
                                    ...step,
                                    stepId: ev.stepId,
                                    stepName: ev.stepName || step.stepName,
                                    status: 'RUNNING',
                                    selectedRoute: undefined,
                                    attempts: ev.attempt ?? 1,
                                    startTime: ev.timestamp,
                                },
                            };
                        }
                        break;
                    case 'step:complete':
                        if (ev.stepId) {
                            const step = updated.steps[ev.stepId] || { stepId: ev.stepId, stepName: ev.stepName };
                            updated.steps = {
                                ...updated.steps,
                                [ev.stepId]: {
                                    ...step,
                                    status: 'COMPLETED',
                                    durationMs: ev.durationMs,
                                    outputSummary: ev.outputSummary,
                                },
                            };
                        }
                        break;
                    case 'step:retry':
                        if (ev.stepId) {
                            const step = updated.steps[ev.stepId] || { stepId: ev.stepId, stepName: ev.stepName };
                            updated.steps = {
                                ...updated.steps,
                                [ev.stepId]: {
                                    ...step,
                                    status: 'RETRYING',
                                    attempts: ev.attempt ?? step.attempts,
                                    error: ev.error,
                                },
                            };
                        }
                        break;
                    case 'step:error':
                        if (ev.stepId) {
                            const step = updated.steps[ev.stepId] || { stepId: ev.stepId, stepName: ev.stepName };
                            updated.steps = {
                                ...updated.steps,
                                [ev.stepId]: {
                                    ...step,
                                    status: 'FAILED',
                                    error: ev.error,
                                },
                            };
                        }
                        break;
                    case 'step:skipped':
                        if (ev.stepId) {
                            const step = updated.steps[ev.stepId] || { stepId: ev.stepId, stepName: ev.stepName };
                            updated.steps = {
                                ...updated.steps,
                                [ev.stepId]: {
                                    ...step,
                                    status: 'SKIPPED',
                                },
                            };
                        }
                        break;
                    case 'context:change':
                        if (ev.field) {
                            updated.context = {
                                ...updated.context,
                                [ev.field]: ev.value,
                            };
                            updated.contextDiffs = [
                                ...(updated.contextDiffs || []),
                                { field: ev.field, value: ev.value, timestamp: ev.timestamp ?? Date.now() },
                            ];
                        }
                        break;
                    case 'notification:dispatched':
                    case 'approval:requested':
                    case 'cache:hit':
                    case 'cache:miss':
                    case 'checkpoint:save':
                        break;
                    default: {
                        const _exhaustive: never = ev.type;
                        void _exhaustive;
                        break;
                    }
                }

                return {
                    ...prev,
                    [stackId]: updated,
                };
            });
        },
        [namespace, maxEvents],
    );

    useEffect(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token') || urlParams.get('apiKey');
        const params = new URLSearchParams();
        if (namespace) params.set('namespace', namespace);
        if (token) params.set('token', token);
        const qs = params.toString();
        const sseUrl = qs ? `/events?${qs}` : '/events';

        const es = new EventSource(sseUrl);
        eventSourceRef.current = es;

        es.onopen = () => setIsConnected(true);
        es.onerror = () => setIsConnected(false);

        SIGLO_EVENT_TYPES.forEach(type => {
            es.addEventListener(type, (e: MessageEvent) => {
                try {
                    const parsed: unknown = JSON.parse(String(e.data));
                    if (isMonitoringEvent(parsed)) {
                        handleIncomingEvent(parsed);
                    }
                } catch (err) {
                    console.error('Failed to parse SSE event data:', err);
                }
            });
        });

        loadWorkflows();

        return () => {
            es.close();
        };
    }, [namespace, handleIncomingEvent, loadWorkflows]);

    return {
        workflows,
        events,
        isConnected,
        refresh: loadWorkflows,
    };
}
