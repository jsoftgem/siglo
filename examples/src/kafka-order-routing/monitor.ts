import { Redis } from 'ioredis';
import { createMonitorServer, RedisMonitoringAdapter } from '@siglo/monitor';
import { createOrderRoutingWorkflow } from './workflow';
import { channel, pubsubClient, redisUrl } from './infrastructure';

async function main() {
    const subscriber = new Redis(redisUrl, { lazyConnect: true });
    subscriber.on('error', error => console.error('Monitor Redis:', error.message));
    await subscriber.connect();
    const workflow = createOrderRoutingWorkflow(async outcome => outcome);
    const monitor = await createMonitorServer({
        port: Number(process.env.MONITOR_PORT || 4300), host: '0.0.0.0',
        flow: workflow, allowRemoteResume: false,
    });
    new RedisMonitoringAdapter({ subscriber: pubsubClient(subscriber), channel, emitter: monitor.emitter });
    await subscriber.subscribe(channel);
    const close = async () => { subscriber.disconnect(); await monitor.close(); };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    console.log('Kafka routing monitor ready');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
