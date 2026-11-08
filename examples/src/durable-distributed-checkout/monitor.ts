import { createMonitorServer, RedisMonitoringAdapter } from '@siglo/monitor';
import { createDemoServices } from '../getting-started/checkout-demo';
import { createDurableCheckout } from './checkout-durable';
import { channel, connectInfrastructure, pubsubClient } from './infrastructure';

async function main() {
    const infra = await connectInfrastructure();
    const subscriber = infra.redis.duplicate();
    subscriber.on('error', error => console.error('Monitor Redis:', error.message));
    await subscriber.connect();
    const { services } = createDemoServices();
    const checkout = createDurableCheckout(services);
    const monitor = await createMonitorServer({
        port: Number(process.env.MONITOR_PORT || 4100),
        host: '0.0.0.0',
        flow: checkout,
        // Compose binds the dashboard to localhost. Enable controls for this demo.
        allowRemoteResume: true,
    });
    new RedisMonitoringAdapter({ subscriber: pubsubClient(subscriber), channel, emitter: monitor.emitter });
    await subscriber.subscribe(channel);
    console.log('Durable checkout monitor ready');
    const close = async () => {
        subscriber.disconnect();
        await monitor.close();
        await infra.close();
    };
    process.once('SIGINT', () => {
        void close();
    });
    process.once('SIGTERM', () => {
        void close();
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
