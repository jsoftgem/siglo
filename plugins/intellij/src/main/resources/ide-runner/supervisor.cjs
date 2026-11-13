// Newline JSON control channel. Worker stdout/stderr are always log events, never protocol frames.
const { fork } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
let child,
    request,
    timer,
    terminal = false;
const send = event =>
    process.stdout.write(JSON.stringify({ type: 'runEvent', runId: request?.runId, ...event }) + '\n');
function cancel() {
    if (!child || !child.connected || timer) return;
    child.send({ type: 'cancel' });
    timer = setTimeout(() => {
        child.kill('SIGKILL');
    }, 1500);
}
createInterface({ input: process.stdin })
    .on('line', line => {
        try {
            const message = JSON.parse(line);
            if (message.type === 'cancel') {
                cancel();
                return;
            }
            if (request) return;
            request = message;
            request = require('./prepare.cjs').prepareExecution(message);
            child = fork(join(__dirname, 'worker.cjs'), [], {
                cwd: request.cwd,
                env: { ...process.env, ...request.env },
                silent: true,
            });
            child.on('message', event => {
                if (['completed', 'failed', 'cancelled'].includes(event.status)) terminal = true;
                send(event);
            });
            for (const stream of [child.stdout, child.stderr])
                stream.on('data', bytes => send({ status: 'log', log: bytes.toString() }));
            child.on('error', error => {
                terminal = true;
                send({ status: 'failed', error: error.message });
            });
            child.on('exit', () => {
                clearTimeout(timer);
                if (!terminal)
                    send({
                        status: timer ? 'cancelled' : 'failed',
                        error: timer ? undefined : 'Execution process exited without a result.',
                    });
                process.exit(0);
            });
            child.send(request);
        } catch (error) {
            send({ status: 'failed', error: error.message });
            process.exit(1);
        }
    })
    .on('close', cancel);
process.on('SIGTERM', () => {
    child?.kill('SIGKILL');
    process.exit(0);
});
