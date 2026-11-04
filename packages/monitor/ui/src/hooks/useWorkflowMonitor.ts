import { useState, useEffect, useRef, useCallback } from 'react';
import { WorkflowRun, MonitoringEvent } from '../types';
import { fetchWorkflows } from '../api/workflowApi';
import { SIGLO_EVENT_TYPES } from '../constants/events';

interface UseWorkflowMonitorOptions {
  namespace?: string;
  maxEvents?: number;
}

export function useWorkflowMonitor({
  namespace = '',
  maxEvents = 500
}: UseWorkflowMonitorOptions = {}) {
  const [workflows, setWorkflows] = useState<Record<string, WorkflowRun>>({});
  const [events, setEvents] = useState<MonitoringEvent[]>([]);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadWorkflows = useCallback(async () => {
    try {
      const list = await fetchWorkflows(namespace || undefined);
      const map: Record<string, WorkflowRun> = {};
      list.forEach((run) => {
        map[run.stackId] = run;
      });
      setWorkflows((prev) => ({ ...prev, ...map }));
    } catch (err) {
      console.error('Failed to load workflows:', err);
    }
  }, [namespace]);

  const handleIncomingEvent = useCallback((ev: MonitoringEvent) => {
    setEvents((prev) => [ev, ...prev].slice(0, maxEvents));

    if (!ev.stackId) return;

    setWorkflows((prev) => {
      const existing = prev[ev.stackId!] || {
        stackId: ev.stackId!,
        namespace: ev.namespace,
        status: 'RUNNING',
        startTime: ev.timestamp || Date.now(),
        steps: {},
        context: {},
        contextDiffs: []
      };

      const updated = { ...existing };

      switch (ev.type) {
        case 'flow:start':
          updated.flowName = ev.flowName || updated.flowName;
          updated.ast = ev.ast || updated.ast;
          updated.status = 'RUNNING';
          break;
        case 'flow:complete':
          updated.status = (ev.status as any) || 'COMPLETED';
          updated.durationMs = ev.durationMs;
          break;
        case 'flow:error':
          updated.status = 'FAILED';
          break;
        case 'flow:suspended': {
          updated.status = 'SUSPENDED';
          updated.waitingForEvent = ev.waitingForEvent;
          const nextSteps = { ...updated.steps };
          for (const sId of Object.keys(nextSteps)) {
            const step = nextSteps[sId];
            if (sId === (ev as any).stepId || (step.status === 'RUNNING' && (step.stepName?.includes('wait') || step.stepName?.includes('Wait')))) {
              nextSteps[sId] = { ...step, status: 'SUSPENDED' as any };
            }
          }
          updated.steps = nextSteps;
          break;
        }
        case 'flow:resumed': {
          updated.status = 'RUNNING';
          updated.waitingForEvent = null;
          const nextSteps = { ...updated.steps };
          for (const sId of Object.keys(nextSteps)) {
            const step = nextSteps[sId];
            if (sId === (ev as any).stepId || step.status === ('SUSPENDED' as any)) {
              nextSteps[sId] = { ...step, status: 'COMPLETED' };
            }
          }
          updated.steps = nextSteps;
          break;
        }
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
                attempts: ev.attempt || 1,
                startTime: ev.timestamp
              }
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
                durationMs: ev.durationMs
              }
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
                status: 'RETRYING' as any,
                attempts: ev.attempt || step.attempts,
                error: ev.error
              }
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
                error: ev.error
              }
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
                status: 'SKIPPED'
              }
            };
          }
          break;
        case 'context:change':
          if (ev.field) {
            updated.context = {
              ...updated.context,
              [ev.field]: ev.value
            };
            updated.contextDiffs = [
              ...(updated.contextDiffs || []),
              { field: ev.field, value: ev.value, timestamp: ev.timestamp || Date.now() }
            ];
          }
          break;
        default:
          break;
      }

      return {
        ...prev,
        [ev.stackId!]: updated
      };
    });
  }, [maxEvents]);

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

    SIGLO_EVENT_TYPES.forEach((type) => {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          const ev: MonitoringEvent = JSON.parse(e.data);
          handleIncomingEvent(ev);
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
    refresh: loadWorkflows
  };
}
