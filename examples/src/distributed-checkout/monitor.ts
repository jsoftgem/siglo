import { Redis } from 'ioredis';
import { createMonitorServer, RedisMonitoringAdapter } from '@siglo/monitor';
import { channel, redisUrl, pubsubClient } from './infrastructure';

async function main() {
    const subscriber = new Redis(redisUrl, { lazyConnect: true });
    subscriber.on('error', error => console.error('Monitor Redis:', error.message));
    await subscriber.connect();
    const monitor = await createMonitorServer({
        port: Number(process.env.MONITOR_PORT || 4000), host: '0.0.0.0', allowRemoteResume: false
    });
    new RedisMonitoringAdapter({ subscriber: pubsubClient(subscriber), channel, emitter: monitor.emitter });
    // Await subscription acknowledgment before declaring readiness.
    await subscriber.subscribe(channel);
    console.log('Checkout monitor ready on port 4000');
    const close = async () => {
        subscriber.disconnect();
        await monitor.close();
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
