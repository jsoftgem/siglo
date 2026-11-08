import type { AiModelConfig, AiProvider } from './types';
import { assertNetworkPolicy } from '@siglo/http';

const endpoints: Record<Exclude<AiProvider, 'custom'>, string> = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    ollama: 'http://localhost:11434/v1',
};
const keyNames = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

export function resolveModel<T>(config: AiModelConfig<T>, ctx: T, stepName: string) {
    if (!config.model.trim()) throw new TypeError('AI model must not be empty');
    if (
        config.requestTimeoutMs !== undefined &&
        (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
    ) {
        throw new TypeError('requestTimeoutMs must be a positive finite number');
    }
    const url = new URL(modelBaseUrl(config));
    assertNetworkPolicy(stepName, url.href, url.hostname, url.port || undefined);
    const apiKey = typeof config.apiKey === 'function' ? config.apiKey(ctx) : config.apiKey;
    const environmentKey =
        config.provider in keyNames ? process.env[keyNames[config.provider as keyof typeof keyNames]] : undefined;
    return { ...config, baseUrl: url.href.replace(/\/$/, ''), apiKey: apiKey ?? environmentKey };
}

export function modelBaseUrl(config: Pick<AiModelConfig, 'provider' | 'baseUrl'>): string {
    const baseUrl = config.baseUrl ?? (config.provider === 'custom' ? undefined : endpoints[config.provider]);
    if (!baseUrl) throw new TypeError('Custom providers require baseUrl');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new TypeError('AI baseUrl must be an HTTP(S) URL without credentials, query or fragment');
    }
    return url.href.replace(/\/$/, '');
}
