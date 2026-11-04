import { NotificationChannel, NotificationTransport } from './types';
const transports = new Map<NotificationChannel, NotificationTransport>();
export function registerNotificationTransport(transport: NotificationTransport): void { transports.set(transport.channel, transport); }
export function getNotificationTransport(channel: NotificationChannel): NotificationTransport {
  const transport = transports.get(channel);
  if (!transport) throw new Error(`No notification transport registered for ${channel}`);
  return transport;
}
export function clearNotificationTransports(): void { transports.clear(); }
