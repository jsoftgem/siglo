import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { requestCancellation as expressCancellation } from '../../../packages/express/src/disconnect';
import { requestCancellation as fastifyCancellation } from '../../../packages/fastify/src/disconnect';

for (const [name, cancellation] of [
    ['Express', expressCancellation],
    ['Fastify', fastifyCancellation],
] as const) {
    describe(`${name} disconnect bridge`, () => {
        it('forwards existing and pre-aborted signals and removes its listeners', () => {
            for (const preAborted of [true, false]) {
                const source = new AbortController();
                if (preAborted) source.abort();
                const request = new EventEmitter();
                const response = new EventEmitter();
                const bridge = cancellation(request, response, source.signal);
                if (!preAborted) source.abort();
                assert.equal(bridge.signal.aborted, true);
                assert.equal(bridge.signal.reason, source.signal.reason);
                bridge.cleanup();
                assert.equal(getEventListeners(source.signal, 'abort').length, 0);
                assert.equal(request.listenerCount('close'), 0);
                assert.equal(request.listenerCount('aborted'), 0);
                assert.equal(response.listenerCount('close'), 0);
            }
        });
        it('distinguishes completed bodies and responses from premature disconnects', () => {
            const request = Object.assign(new EventEmitter(), { complete: true });
            const response = Object.assign(new EventEmitter(), { writableFinished: true });
            const bridge = cancellation(request, response);
            try {
                request.emit('close');
                response.emit('close');
                assert.equal(bridge.signal.aborted, false);
                request.complete = false;
                request.emit('close');
                assert.equal(bridge.signal.aborted, true);
            } finally {
                bridge.cleanup();
            }
        });
    });
}
