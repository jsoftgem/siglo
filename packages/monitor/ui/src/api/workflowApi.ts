import { WorkflowRun } from '../types/workflow';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAuthHeaders(): Record<string, string> {
    const urlParams = new URLSearchParams(window.location.search);
    const token =
        urlParams.get('token') ||
        urlParams.get('apiKey') ||
        (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('siglo_monitor_token') : null);
    if (token) {
        return {
            Authorization: `Bearer ${token}`,
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
    const base = namespace ? `/api/workflows?namespace=${encodeURIComponent(namespace)}` : '/api/workflows';
    const url = appendTokenQuery(base);

    const res = await fetch(url, {
        headers: {
            ...getAuthHeaders(),
        },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch workflows: ${res.statusText}`);
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
        throw new Error('Invalid workflows response payload');
    }
    return data as WorkflowRun[];
}

export async function fetchWorkflowById(stackId: string): Promise<WorkflowRun> {
    const url = appendTokenQuery(`/api/workflows/${encodeURIComponent(stackId)}`);
    const res = await fetch(url, {
        headers: {
            ...getAuthHeaders(),
        },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch workflow ${stackId}: ${res.statusText}`);
    }
    const data: unknown = await res.json();
    if (!isPlainRecord(data) || typeof data.stackId !== 'string') {
        throw new Error('Invalid workflow response payload');
    }
    return data as unknown as WorkflowRun;
}

export async function resumeWorkflow(
    stackId: string,
    eventName: string,
    payload: unknown,
): Promise<{ ok: boolean; stackId: string }> {
    const url = appendTokenQuery(`/api/workflows/${encodeURIComponent(stackId)}/resume`);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
        },
        body: JSON.stringify({ eventName, payload }),
    });

    if (!res.ok) {
        const errorData: unknown = await res.json().catch(() => ({}));
        const errorMessage =
            isPlainRecord(errorData) && typeof errorData.error === 'string' ? errorData.error : undefined;
        throw new Error(errorMessage || `Failed to resume workflow: ${res.statusText}`);
    }

    const data: unknown = await res.json();
    if (!isPlainRecord(data) || typeof data.ok !== 'boolean' || typeof data.stackId !== 'string') {
        throw new Error('Invalid resume response payload');
    }
    return { ok: data.ok, stackId: data.stackId };
}

export async function replayWorkflow(stackId: string): Promise<{ ok: boolean; stackId: string }> {
    const url = appendTokenQuery(`/api/workflows/${encodeURIComponent(stackId)}/replay`);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            ...getAuthHeaders(),
        },
    });

    if (!res.ok) {
        const errorData: unknown = await res.json().catch(() => ({}));
        const errorMessage =
            isPlainRecord(errorData) && typeof errorData.error === 'string' ? errorData.error : undefined;
        throw new Error(errorMessage || `Failed to replay workflow: ${res.statusText}`);
    }

    const data: unknown = await res.json();
    if (!isPlainRecord(data) || typeof data.ok !== 'boolean' || typeof data.stackId !== 'string') {
        throw new Error('Invalid replay response payload');
    }
    return { ok: data.ok, stackId: data.stackId };
}
