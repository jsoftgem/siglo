import type { EcosystemInspection } from '@siglo/core';

/** Deliberately excludes path, query, credentials, headers and content. */
export function sanitizedCurl(data: EcosystemInspection): string | undefined {
  if (data.kind !== 'http' || !data.url || !data.method || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(data.method)) return undefined;
  try {
    const url = new URL(data.url);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return `curl --request ${data.method} --url '${url.origin.replace(/'/g, "'\\''")}'`;
  } catch { return undefined; }
}
