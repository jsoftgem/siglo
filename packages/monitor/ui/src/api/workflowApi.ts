import { WorkflowRun } from '../types/workflow';

function getAuthHeaders(): Record<string, string> {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token') || urlParams.get('apiKey') || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('siglo_monitor_token') : null);
  if (token) {
    return {
      'Authorization': `Bearer ${token}`
    };
  }
  return {};
}

function appendTokenQuery(url: string): string {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token') || urlParams.get('apiKey');
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export async function fetchWorkflows(namespace?: string): Promise<WorkflowRun[]> {
  const base = namespace
    ? `/api/workflows?namespace=${encodeURIComponent(namespace)}`
    : '/api/workflows';
  const url = appendTokenQuery(base);

  const res = await fetch(url, {
    headers: {
      ...getAuthHeaders()
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch workflows: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchWorkflowById(stackId: string): Promise<WorkflowRun> {
  const url = appendTokenQuery(`/api/workflows/${encodeURIComponent(stackId)}`);
  const res = await fetch(url, {
    headers: {
      ...getAuthHeaders()
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch workflow ${stackId}: ${res.statusText}`);
  }
  return res.json();
}

export async function resumeWorkflow(
  stackId: string,
  eventName: string,
  payload: any
): Promise<{ ok: boolean; stackId: string }> {
  const url = appendTokenQuery(`/api/workflows/${encodeURIComponent(stackId)}/resume`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders()
    },
    body: JSON.stringify({ eventName, payload })
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to resume workflow: ${res.statusText}`);
  }

  return res.json();
}

export async function replayWorkflow(
  stackId: string
): Promise<{ ok: boolean; stackId: string }> {
  const url = appendTokenQuery(`/api/workflows/${encodeURIComponent(stackId)}/replay`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...getAuthHeaders()
    }
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to replay workflow: ${res.statusText}`);
  }

  return res.json();
}
