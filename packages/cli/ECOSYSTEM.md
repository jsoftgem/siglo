# Ecosystem step generation

Use `siglo generate step <name> --type=<type>` from your project directory.
Names may be identifiers or kebab-case. Generation rejects invalid options and
existing step or test files; it never merges into an existing file.

```sh
siglo generate step callStripe --type=http --url=https://api.stripe.com/v1/charges
siglo generate step verifyStripeWebhook --type=crypto --provider=stripe
siglo generate step managerApproval --type=notification --channel=slack --interactive=true
siglo generate step triageTicket --type=ai --provider=anthropic --model=YOUR_MODEL_ID
```

The default remains the generic step and Mocha/Chai test. Ecosystem templates
export a `create<Name>Step` factory so tests can supply adapters, transports or
secret resolvers. Generated filenames retain the existing lowercase convention.
Options use `--key=value`; interactive prompting is not implemented.

## Consumer dependencies

Use Node.js `^22.13.0 || >=24`, TypeScript 5.7+, `tsx`, and `@types/node`.
Install `@siglo/core` and the package selected by the template (`@siglo/http`,
`@siglo/crypto`, `@siglo/notifications`, or `@siglo/ai`) as runtime dependencies.
Tests import each package's testing subpath; no separate mock package is needed.
The crypto test uses Node's built-in HMAC implementation: crypto has no testing
subpath. The HTTP and AI templates contain a concrete Standard Schema validator
and require no third-party validator. If replacing it with Zod, install Zod as a
runtime dependency. Generic templates additionally require Mocha, Chai, and their
types as development dependencies.

Run ecosystem tests serially because the HTTP testing utility replaces global
fetch:

```sh
node --import tsx --test --test-concurrency=1 src/steps/*.step.test.ts
```

Run generic tests with `mocha -r tsx 'src/steps/*.step.test.ts'`. Do not mix the
two runner conventions in a single invocation. Compile generated files with
`tsc --noEmit` using Node16 module resolution, ES2022 target, and esModuleInterop.

## Runtime wiring

HTTP uses a static URL and POST with sample request and response validators.
Change the sample body and validators to your API contract. Static URLs declare
the hostname automatically; a URL resolver must explicitly declare permitted
hosts using `.allowNetwork([...])`. Tests install core network interceptors
before replacing fetch, restore fetch in `finally`, and reject unmatched calls.
The mock covers fetch only; it does not isolate other transports.

Webhook factories resolve `WEBHOOK_SECRET` at runtime, or accept an injected
resolver. Pass raw request bytes/string and signature headers. Never parse and
re-serialize the body before verification. Tests sign a synthetic body locally
and verify rejection after tampering. Supported providers are Stripe, GitHub,
Shopify, Slack, Svix, and generic HMAC.

AI factories accept an optional adapter inside the model configuration. Supply
a provider-supported model ID and configure that provider's credentials in the
application. Tests inject `MockAiProvider`, validate structured data, and assert
`result.data`. Supported generated providers are OpenAI, Anthropic, Gemini and
Ollama; custom adapters remain available through the package API.

Notification factories require an explicit transport. For example:

```ts
import { SlackTransport, ResendTransport } from '@siglo/notifications';
const slack = new SlackTransport({ apiKey: process.env.SLACK_TOKEN! });
const email = new ResendTransport({
    apiKey: process.env.RESEND_API_KEY!,
    from: 'workflow@example.com',
});
```

For Discord use `DiscordTransport`; for SMS use `TwilioTransport` with the provider's configuration; for push use
`PushWebhookTransport` or implement the `NotificationTransport` interface. Replace the generated example recipient.
The factory supplies transport host declarations to the runtime. Tests use
`MockNotificationTransport` and perform no delivery.

Approval generation is explicit and supports email and Slack. The generated
step dispatches signed actions; it does not itself suspend the workflow. In the
application, use a unique correlation key for each approval, register a durable
wait for the approved/rejected events, configure persistent workflow storage and
the notification dispatch/revocation stores, and expose the package's callback
handler with the same signing secret. Authorize the approver at that boundary.
Use an HTTPS callback URL and keep signing secrets in runtime configuration.
The generated test verifies action dispatch only, not durable resume or expiry.
