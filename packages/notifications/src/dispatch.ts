import type { ResolvedNotificationMessage } from './types';
export interface DispatchIntent {
    message: ResolvedNotificationMessage;
    extra?: Record<string, unknown>;
}
/** Retain intents for at least the entire retry window. Never regenerate tokens on a retry. */
export interface NotificationDispatchStore {
    prepare(key: string, create: () => Promise<DispatchIntent>): Promise<DispatchIntent>;
}
export class InMemoryNotificationDispatchStore implements NotificationDispatchStore {
    private intents = new Map<string, Promise<DispatchIntent>>();
    async prepare(key: string, create: () => Promise<DispatchIntent>): Promise<DispatchIntent> {
        let intent = this.intents.get(key);
        if (!intent) {
            intent = create();
            this.intents.set(key, intent);
            intent.catch(() => {
                if (this.intents.get(key) === intent) this.intents.delete(key);
            });
        }
        return intent;
    }
}
export class PostgresNotificationDispatchStore implements NotificationDispatchStore {
    constructor(private client: { query(sql: string, values?: any[]): Promise<{ rows: any[] }> }) {}
    async initialize(): Promise<void> {
        await this.client.query(
            'CREATE TABLE IF NOT EXISTS siglo_notification_dispatches (dispatch_key TEXT PRIMARY KEY, intent JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        );
    }
    async prepare(key: string, create: () => Promise<DispatchIntent>): Promise<DispatchIntent> {
        const existing = await this.client.query(
            'SELECT intent FROM siglo_notification_dispatches WHERE dispatch_key = $1',
            [key],
        );
        if (existing.rows.length) return existing.rows[0].intent;
        const intent = await create();
        const result = await this.client.query(
            `INSERT INTO siglo_notification_dispatches (dispatch_key, intent) VALUES ($1, $2::jsonb)
      ON CONFLICT (dispatch_key) DO UPDATE SET dispatch_key = EXCLUDED.dispatch_key RETURNING intent`,
            [key, JSON.stringify(intent)],
        );
        return result.rows[0].intent;
    }
}
let store: NotificationDispatchStore = new InMemoryNotificationDispatchStore();
export function configureNotificationDispatchStore(value: NotificationDispatchStore): void {
    store = value;
}
export function getNotificationDispatchStore(): NotificationDispatchStore {
    return store;
}
