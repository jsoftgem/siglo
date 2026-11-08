import { publicNotificationFetch } from './egress';
import { assertNetworkPolicy } from '@siglo/http';
import { NotificationTransport, ResolvedNotificationMessage, NotificationChannel } from './types';
export const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderNotificationHtml(m: ResolvedNotificationMessage): string {
    const a = m.interactiveActions;
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px;font-family:Arial,sans-serif"><main style="max-width:600px;margin:auto"><p>${escapeHtml(m.content)}</p>${a ? `<p>${escapeHtml(a.description ?? '')}</p><a href="${escapeHtml(a.approveUrl)}">Approve</a> <a href="${escapeHtml(a.rejectUrl)}">Reject</a>` : ''}</main></body></html>`;
}
interface HttpTransportOptions {
    apiKey: string;
    from?: string;
    fetch?: typeof fetch;
}
function recipient(m: ResolvedNotificationMessage, channel: NotificationChannel): string {
    if (typeof m.to === 'string') return m.to;
    return (
        channel === 'email'
            ? m.to.email
            : channel === 'sms'
              ? m.to.phone
              : channel === 'slack'
                ? m.to.slackChannelId || m.to.slackUserId
                : m.to.discordWebhookUrl
    )!;
}
async function post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal | undefined,
    request = publicNotificationFetch,
): Promise<any> {
    const u = new URL(url);
    assertNetworkPolicy('notificationTransport', url, u.hostname, u.port);
    const r = await request(url, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal,
        redirect: 'error',
    });
    if (!r.ok) throw new Error(`Notification provider failed (${r.status})`);
    return r.status === 204 ? {} : r.json();
}
export class SlackTransport implements NotificationTransport {
    readonly channel = 'slack';
    readonly allowedHosts = ['slack.com'];
    constructor(private options: HttpTransportOptions) {}
    private async call(method: string, body: unknown, signal?: AbortSignal): Promise<any> {
        const r = await post(
            `https://slack.com/api/${method}`,
            { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
            body,
            signal,
            this.options.fetch,
        );
        if (!r.ok) throw new Error('Slack notification request failed');
        return r;
    }
    async send(m: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        const a = m.interactiveActions;
        const r = await this.call(
            'chat.postMessage',
            {
                channel: recipient(m, this.channel),
                text: m.content,
                blocks: [
                    { type: 'section', text: { type: 'plain_text', text: m.content } },
                    ...(a
                        ? [
                              {
                                  type: 'actions',
                                  elements: [
                                      {
                                          type: 'button',
                                          text: { type: 'plain_text', text: 'Approve' },
                                          url: a.approveUrl,
                                      },
                                      {
                                          type: 'button',
                                          text: { type: 'plain_text', text: 'Reject' },
                                          url: a.rejectUrl,
                                      },
                                  ],
                              },
                          ]
                        : []),
                ],
            },
            m.signal,
        );
        return { id: `${r.channel}:${r.ts}`, timestamp: Date.now() };
    }
    async openModal(
        triggerId: string,
        view: { title: string; blocks: unknown[]; callbackId?: string },
        signal?: AbortSignal,
    ): Promise<string> {
        if (!triggerId || !view.title || view.title.length > 24)
            throw new Error('A trigger ID and modal title of at most 24 characters are required');
        const result = await this.call(
            'views.open',
            {
                trigger_id: triggerId,
                view: {
                    type: 'modal',
                    title: { type: 'plain_text', text: view.title },
                    blocks: view.blocks,
                    callback_id: view.callbackId,
                },
            },
            signal,
        );
        return result.view.id;
    }
    async cancel(id: string, reason: string): Promise<void> {
        const [channel, ts] = id.split(':');
        await this.call('chat.update', { channel, ts, text: reason, blocks: [] });
    }
}
export class ResendTransport implements NotificationTransport {
    readonly channel = 'email';
    readonly allowedHosts = ['api.resend.com'];
    constructor(private options: HttpTransportOptions) {}
    async send(m: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        const r = await post(
            'https://api.resend.com/emails',
            {
                Authorization: `Bearer ${this.options.apiKey}`,
                'Content-Type': 'application/json',
                ...(m.idempotencyKey ? { 'Idempotency-Key': m.idempotencyKey } : {}),
            },
            {
                from: this.options.from,
                to: recipient(m, this.channel),
                subject: m.subject ?? m.content,
                html: renderNotificationHtml(m),
            },
            m.signal,
            this.options.fetch,
        );
        return { id: r.id, timestamp: Date.now() };
    }
}
export class SendGridTransport implements NotificationTransport {
    readonly channel = 'email';
    readonly allowedHosts = ['api.sendgrid.com'];
    constructor(private options: HttpTransportOptions) {}
    async send(m: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        const url = 'https://api.sendgrid.com/v3/mail/send';
        assertNetworkPolicy('sendgrid', url, 'api.sendgrid.com');
        const r = await (this.options.fetch ?? publicNotificationFetch)(url, {
            method: 'POST',
            redirect: 'error',
            signal: m.signal,
            headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: recipient(m, this.channel) }] }],
                from: { email: this.options.from },
                subject: m.subject ?? m.content,
                content: [{ type: 'text/html', value: renderNotificationHtml(m) }],
            }),
        });
        if (!r.ok) throw new Error(`SendGrid notification failed (${r.status})`);
        return { id: r.headers.get('x-message-id') ?? '', timestamp: Date.now() };
    }
}
export class DiscordTransport implements NotificationTransport {
    readonly channel = 'discord';
    readonly allowedHosts = ['discord.com'];
    constructor(private request = publicNotificationFetch) {}
    async send(m: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        const u = new URL(recipient(m, this.channel));
        if (u.protocol !== 'https:' || u.hostname !== 'discord.com' || !u.pathname.startsWith('/api/webhooks/'))
            throw new Error('Invalid Discord webhook');
        u.searchParams.set('wait', 'true');
        const r = await post(
            u.toString(),
            { 'Content-Type': 'application/json' },
            {
                content: m.content,
                allowed_mentions: { parse: [] },
                embeds: m.interactiveActions
                    ? [
                          {
                              title: m.interactiveActions.title,
                              description: `${m.interactiveActions.description ?? ''}\n[Approve](${m.interactiveActions.approveUrl}) · [Reject](${m.interactiveActions.rejectUrl})`,
                          },
                      ]
                    : undefined,
            },
            m.signal,
            this.request,
        );
        return { id: r.id, timestamp: Date.now() };
    }
}
export class TwilioTransport implements NotificationTransport {
    readonly channel = 'sms';
    readonly allowedHosts = ['api.twilio.com'];
    constructor(private options: { accountSid: string; authToken: string; from: string; fetch?: typeof fetch }) {}
    async send(m: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        if (!/^AC[a-zA-Z0-9]+$/.test(this.options.accountSid)) throw new Error('Invalid Twilio account SID');
        const r = await post(
            `https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`,
            {
                Authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            new URLSearchParams({
                To: recipient(m, this.channel),
                From: this.options.from,
                Body: m.content,
            }).toString(),
            m.signal,
            this.options.fetch,
        );
        return { id: r.sid, timestamp: Date.now() };
    }
}
/** Inject an SMTP client (e.g. Nodemailer) without imposing an SMTP dependency. */
export class SmtpTransport implements NotificationTransport {
    readonly channel = 'email';
    readonly allowedHosts: string[];
    constructor(
        private options: {
            host: string;
            from: string;
            sendMail: (mail: {
                from: string;
                to: string;
                subject: string;
                html: string;
                signal?: AbortSignal;
            }) => Promise<{ messageId: string }>;
        },
    ) {
        this.allowedHosts = [options.host];
    }
    async send(m: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        assertNetworkPolicy('smtp', `smtp://${this.options.host}`, this.options.host);
        const r = await this.options.sendMail({
            from: this.options.from,
            to: recipient(m, this.channel),
            subject: m.subject ?? m.content,
            html: renderNotificationHtml(m),
            signal: m.signal,
        });
        return { id: r.messageId, timestamp: Date.now() };
    }
}

export class PostmarkTransport implements NotificationTransport {
    readonly channel = 'email';
    readonly allowedHosts = ['api.postmarkapp.com'];
    constructor(private options: HttpTransportOptions) {}
    async send(message: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        const result = await post(
            'https://api.postmarkapp.com/email',
            { 'X-Postmark-Server-Token': this.options.apiKey, 'Content-Type': 'application/json' },
            {
                From: this.options.from,
                To: recipient(message, 'email'),
                Subject: message.subject ?? message.content,
                HtmlBody: renderNotificationHtml(message),
                TextBody: message.content,
            },
            message.signal,
            this.options.fetch,
        );
        if (result.ErrorCode) throw new Error('Postmark notification request failed');
        return { id: result.MessageID, timestamp: Date.now() };
    }
}

/** Sends a provider-neutral JSON push payload to a configured HTTPS webhook. */
export class PushWebhookTransport implements NotificationTransport {
    readonly channel = 'push';
    readonly allowedHosts: string[];
    constructor(private options: { url: string; headers?: Record<string, string>; fetch?: typeof fetch }) {
        const url = new URL(options.url);
        if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('Push webhook must use HTTPS without URL credentials');
        this.allowedHosts = [url.hostname];
    }
    async send(message: ResolvedNotificationMessage): Promise<{ id: string; timestamp: number }> {
        const result = await post(
            this.options.url,
            {
                ...this.options.headers,
                'Content-Type': 'application/json',
                ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
            },
            {
                to: typeof message.to === 'string' ? message.to : message.to.pushToken,
                title: message.subject,
                body: message.content,
                actions: message.interactiveActions,
                metadata: message.metadata,
            },
            message.signal,
            this.options.fetch,
        );
        if (typeof result.id !== 'string' || !result.id)
            throw new Error('Push webhook response must contain a message id');
        return { id: result.id, timestamp: Date.now() };
    }
}
