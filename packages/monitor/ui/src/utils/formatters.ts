export function formatTime(timestamp?: number): string {
  if (!timestamp) return '--:--:--';
  return new Date(timestamp).toLocaleTimeString();
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null || typeof durationMs !== 'number' || isNaN(durationMs)) {
    return 'In progress...';
  }
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

export function truncateId(id: string, maxLen: number = 8): string {
  if (!id) return '';
  if (id.length <= maxLen) return id;
  return `${id.slice(0, maxLen)}...`;
}

export function formatJson(data: any): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
