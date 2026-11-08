export interface InterceptOptions {
    path?: string | RegExp;
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, any>;
    body?: any;
}

export interface MockReplyOptions {
    headers?: Record<string, string>;
}

export interface InterceptRule {
    origin?: string;
    path?: string | RegExp;
    url?: string | RegExp;
    method: string;
    expectedHeaders?: Record<string, string>;
    expectedBody?: any;
    statusCode?: number;
    responseBody?: any;
    responseOptions?: MockReplyOptions;
    error?: Error;
    remainingCalls: number;
}

export class MockInterceptor {
    constructor(private rule: InterceptRule) {}

    reply(statusCode: number, data?: any, options?: MockReplyOptions): this {
        this.rule.statusCode = statusCode;
        this.rule.responseBody = data;
        this.rule.responseOptions = options;
        return this;
    }

    replyWithError(error: Error): this {
        this.rule.error = error;
        return this;
    }

    times(count: number): this {
        this.rule.remainingCalls = count;
        return this;
    }
}

export class MockOriginClient {
    constructor(
        private origin: string,
        private server: MockHttpServer,
    ) {}

    intercept(options: InterceptOptions = {}): MockInterceptor {
        return this.server.registerRule({
            origin: this.origin,
            path: options.path,
            method: (options.method || 'GET').toUpperCase(),
            expectedHeaders: options.headers,
            expectedBody: options.body,
            remainingCalls: 1,
        });
    }
}

export class MockHttpServer {
    private rules: InterceptRule[] = [];
    private originalFetch: typeof globalThis.fetch;
    private netConnectAllowed = false;
    private installed = false;

    constructor() {
        this.originalFetch = globalThis.fetch;
        this.install();
    }

    private install(): void {
        if (this.installed) return;
        this.installed = true;

        globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
            // Check if signal already aborted
            if (init?.signal?.aborted) {
                const abortErr = new Error(init.signal.reason?.message || 'This operation was aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
            }

            const urlStr = typeof input === 'string' ? input : input?.url || String(input);
            const method = ((init?.method || input?.method || 'GET') as string).toUpperCase();
            const parsedUrl = new URL(urlStr);
            const origin = parsedUrl.origin;
            const pathname = parsedUrl.pathname;

            // Find matching rule
            const ruleIndex = this.rules.findIndex(r => {
                if (r.remainingCalls <= 0) return false;
                if (r.method !== method) return false;

                // Check origin
                if (r.origin && r.origin !== origin) return false;

                // Check path
                if (r.path) {
                    if (typeof r.path === 'string') {
                        if (r.path !== pathname && r.path !== `${pathname}${parsedUrl.search}`) return false;
                    } else if (r.path instanceof RegExp) {
                        if (!r.path.test(pathname) && !r.path.test(`${pathname}${parsedUrl.search}`)) return false;
                    }
                }

                // Check url full
                if (r.url) {
                    if (typeof r.url === 'string') {
                        if (r.url !== urlStr) return false;
                    } else if (r.url instanceof RegExp) {
                        if (!r.url.test(urlStr)) return false;
                    }
                }

                return true;
            });

            if (ruleIndex === -1) {
                if (!this.netConnectAllowed) {
                    throw new Error(`MockHttpServer: No intercept matched for ${method} ${urlStr}`);
                }
                return this.originalFetch(input, init);
            }

            const matchedRule = this.rules[ruleIndex];
            matchedRule.remainingCalls--;

            if (matchedRule.error) {
                throw matchedRule.error;
            }

            const status = matchedRule.statusCode ?? 200;
            const resHeaders = new Headers(matchedRule.responseOptions?.headers || {});

            // For 204 No Content, 205 Reset Content, and 304 Not Modified, body MUST be null in WHATWG Response
            const isBodylessStatus = status === 204 || status === 205 || status === 304;

            let finalBody: BodyInit | null;
            if (isBodylessStatus || matchedRule.responseBody === undefined || matchedRule.responseBody === null) {
                finalBody = null;
            } else if (typeof matchedRule.responseBody === 'function') {
                const bodyPromise = Promise.resolve().then(() => matchedRule.responseBody());
                if (init?.signal) {
                    finalBody = await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            const abortErr = new Error(init.signal.reason?.message || 'This operation was aborted');
                            abortErr.name = 'AbortError';
                            reject(abortErr);
                        };
                        init.signal.addEventListener('abort', onAbort, { once: true });
                        bodyPromise.then(
                            res => {
                                init.signal.removeEventListener('abort', onAbort);
                                resolve(typeof res === 'string' ? res : JSON.stringify(res));
                            },
                            err => {
                                init.signal.removeEventListener('abort', onAbort);
                                reject(err);
                            },
                        );
                    });
                } else {
                    const generated = await bodyPromise;
                    finalBody = typeof generated === 'string' ? generated : JSON.stringify(generated);
                }
            } else if (typeof matchedRule.responseBody === 'string') {
                finalBody = matchedRule.responseBody;
            } else {
                finalBody = JSON.stringify(matchedRule.responseBody);
                if (!resHeaders.has('content-type')) {
                    resHeaders.set('content-type', 'application/json');
                }
            }

            // Check signal one more time before returning
            if (init?.signal?.aborted) {
                const abortErr = new Error(init.signal.reason?.message || 'This operation was aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
            }

            const response = new Response(finalBody, {
                status,
                statusText:
                    status === 200
                        ? 'OK'
                        : status === 404
                          ? 'Not Found'
                          : status === 429
                            ? 'Too Many Requests'
                            : status === 204
                              ? 'No Content'
                              : 'Mock Response',
                headers: resHeaders,
            });

            return response;
        };
    }

    get(origin: string): MockOriginClient {
        // Normalize origin: strip trailing slashes
        const normalizedOrigin = origin.replace(/\/+$/, '');
        return new MockOriginClient(normalizedOrigin, this);
    }

    intercept(options: {
        url: string | RegExp;
        method?: string;
        headers?: Record<string, string>;
        body?: any;
    }): MockInterceptor {
        return this.registerRule({
            url: options.url,
            method: (options.method || 'GET').toUpperCase(),
            expectedHeaders: options.headers,
            expectedBody: options.body,
            remainingCalls: 1,
        });
    }

    registerRule(rule: InterceptRule): MockInterceptor {
        this.rules.push(rule);
        return new MockInterceptor(rule);
    }

    disableNetConnect(): this {
        this.netConnectAllowed = false;
        return this;
    }

    enableNetConnect(): this {
        this.netConnectAllowed = true;
        return this;
    }

    isDone(): boolean {
        return this.rules.every(r => r.remainingCalls === 0);
    }

    assertDone(): void {
        const pending = this.rules.filter(r => r.remainingCalls > 0);
        if (pending.length > 0) {
            throw new Error(`MockHttpServer: ${pending.length} pending mock rule(s) were not called.`);
        }
    }

    reset(): void {
        this.rules = [];
    }

    close(): void {
        this.restore();
    }

    restore(): void {
        if (this.installed) {
            globalThis.fetch = this.originalFetch;
            this.installed = false;
            this.rules = [];
        }
    }
}

/**
 * Creates and returns a deterministic MockHttpServer.
 */
export function createMockHttpServer(): MockHttpServer {
    return new MockHttpServer();
}
