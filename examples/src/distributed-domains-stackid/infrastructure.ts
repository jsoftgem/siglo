import { Redis } from 'ioredis';

export const channel = 'tutorial:distributed-domains:events';
export const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6383';

/**
 * Adapt ioredis client to the RedisMonitoringAdapter interface.
 */
export function pubsubClient(redis: Redis) {
    return {
        publish: (topic: string, message: string) => redis.publish(topic, message),
        subscribe: (topic: string) => redis.subscribe(topic),
        on: (event: 'message', listener: (topic: string, message: string) => void) => redis.on(event, listener),
    };
}
