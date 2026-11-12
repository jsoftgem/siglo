import { within } from '../engine/deadline';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { flow, Step } from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';
import { sigloFastifyHandler } from '@siglo/fastify';
import { sigloMiddleware } from '@siglo/hono';
import { exploreCases } from '../engine/charter';

export async function runHttpAbortCharter(iterations = 20, seed = 6006) {
    return exploreCases(
        'Charter 6: Web adapter disconnects and cleanup',
        iterations,
        seed,
        [4, 10],
        async (rng, i, record) => {
            for (const adapter of ['express', 'fastify', 'hono']) {
                for (const cancelled of [true, false]) {
                    const request = Object.assign(new EventEmitter(), { headers: {}, body: {}, complete: true });
                    const response = Object.assign(new EventEmitter(), {
                        writableFinished: false,
                        statusCode: 200,
                        status(code: number) {
                            this.statusCode = code;
                            return this;
                        },
                        code(code: number) {
                            this.statusCode = code;
                            return this;
                        },
                        json(_value: unknown) {
                            return this;
                        },
                        send(_value: unknown) {
                            return this;
                        },
                    });
                    const controller = new AbortController();
                    const fetchRequest = new Request('http://localhost/', { signal: controller.signal });
                    let started!: () => void;
                    const ready = new Promise<void>(resolve => {
                        started = resolve;
                    });
                    let downstream = 0;
                    let activeTimers = 0;
                    const workflow = flow(
                        Step.create(`blocking_${i}`, async (ctx: any) => {
                            const signal: AbortSignal = ctx.$signal();
                            started();
                            await new Promise<void>((resolve, reject) => {
                                activeTimers++;
                                const cleanup = () => {
                                    clearTimeout(timer);
                                    activeTimers--;
                                    signal.removeEventListener('abort', abort);
                                };
                                const abort = () => {
                                    cleanup();
                                    reject(signal.reason);
                                };
                                const timer = setTimeout(
                                    () => {
                                        cleanup();
                                        resolve();
                                    },
                                    cancelled ? 500 : 1,
                                );
                                signal.addEventListener('abort', abort, { once: true });
                                if (signal.aborted) abort();
                            });
                            return { ok: true };
                        }),
                        Step.create(`after_${i}`, async () => {
                            downstream++;
                            return {};
                        }),
                    );
                    let run: Promise<any>;
                    if (adapter === 'express')
                        run = sigloExpressMiddleware(workflow)(request, response, error => {
                            if (error) throw error;
                        });
                    else if (adapter === 'fastify') run = sigloFastifyHandler(workflow)({ raw: request }, response);
                    else
                        run = sigloMiddleware(workflow)({
                            req: { raw: fetchRequest, header: () => 'application/json', json: async () => ({}) },
                            json: (_body: unknown, status?: number) => {
                                response.statusCode = status ?? 200;
                            },
                        });
                    await within(ready, 2000, `${adapter}: workflow did not start`);
                    // A completed request body is not a disconnected client.
                    request.emit('close');
                    if (cancelled) {
                        const event = rng.pick(['aborted', 'response-close']);
                        record({ adapter, cancelled, event });
                        if (adapter === 'hono') controller.abort();
                        else if (event === 'aborted') request.emit('aborted');
                        else response.emit('close');
                    }
                    await within(run, 2000, `${adapter}: request did not settle`);
                    assert.equal(downstream, cancelled ? 0 : 1, adapter);
                    if (cancelled) assert.equal(response.statusCode, 499, adapter);
                    assert.equal(activeTimers, 0, adapter);
                    assert.equal(request.listenerCount('aborted'), 0);
                    assert.equal(request.listenerCount('close'), 0);
                    assert.equal(response.listenerCount('close'), 0);
                    assert.equal(getEventListeners(fetchRequest.signal, 'abort').length, 0);
                }
            }
        },
    );
}
