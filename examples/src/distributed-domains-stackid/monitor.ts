import { Redis } from 'ioredis';
import { createMonitorServer, RedisMonitoringAdapter } from '@siglo/monitor';
import { channel, redisUrl, pubsubClient } from './infrastructure';

async function main() {
    const subscriber = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 5 });
    subscriber.on('error', error => console.error('[Monitor] Redis Error:', error.message));
    await subscriber.connect();

    const port = Number(process.env.MONITOR_PORT || 4200);
    const monitor = await createMonitorServer({
        port,
        host: '0.0.0.0',
        allowRemoteResume: false,
    });

    // Attach Redis subscriber to monitor emitter so all events published to Redis feed the dashboard
    new RedisMonitoringAdapter({
        subscriber: pubsubClient(subscriber),
        channel,
        emitter: monitor.emitter,
    });

    await subscriber.subscribe(channel);
    console.log(`[Monitor] Live Monitoring Dashboard ready at http://127.0.0.1:${port}`);

    const close = async () => {
        subscriber.disconnect();
        await monitor.close();
    };

    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
