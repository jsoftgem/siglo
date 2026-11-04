import { NotificationChannel, NotificationTransport, ResolvedNotificationMessage } from '../types';
export class MockNotificationTransport implements NotificationTransport {
  readonly messages: ResolvedNotificationMessage[] = [];
  readonly cancellations: { id: string; reason: string }[] = [];
  constructor(readonly channel: NotificationChannel = 'email', readonly allowedHosts: string[] = [], private now = Date.now) {}
  async send(message: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> { this.messages.push(message); return { id: `mock-${this.messages.length}`, timestamp: this.now() }; }
  async cancel(id: string, reason: string): Promise<void> { this.cancellations.push({ id, reason }); }
}
