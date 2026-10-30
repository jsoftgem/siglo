# Phase 4 Roadmap: Developer Experience, CLI & Live DevTools Integration

> Detailed implementation design, runtime contracts, UI inspectors, and CLI generator specifications for integrating `@siglo/http`, `@siglo/crypto`, `@siglo/notifications`, and `@siglo/ai` into Siglo's developer ecosystem.

---

## 1. Executive Overview

Phase 4 connects all ecosystem packages into Siglo's visual developer toolchain:
1. **Developer CLI Scaffolding**: Fast generation of pre-configured, type-safe ecosystem steps via `@siglo/cli`.
2. **Dedicated DevTools Inspectors**: Custom UI tabs and inspect panels in Siglo's visual DevTools for HTTP requests, crypto verification, notification previews, and AI token waterfalls.
3. **Deterministic Replay & Offline Mocks**: Unified testing fixtures allowing zero-network unit and integration testing.

---

## 2. CLI Scaffolding Extensions (`@siglo/cli`)

Extend `@siglo/cli` with interactive and scripted code generation for ecosystem steps.

### 2.1 CLI Commands

```bash
# Generate an HTTP step with automatic ASL network policy & schema
npx siglo generate:step --type http --name callStripe --url "https://api.stripe.com/v1/charges"

# Generate a webhook verification step
npx siglo generate:step --type crypto --name verifyStripeWebhook --provider stripe

# Generate an interactive Slack/Email approval step
npx siglo generate:step --type notification --name managerApproval --channel slack

# Generate a structured output AI step with Zod schema
npx siglo generate:step --type ai --name triageTicket --provider anthropic --model claude-3-5-sonnet
```

### 2.2 Template Scaffolding Output
Generated steps come pre-configured with:
- Standard Schema imports.
- Proper TypeScript generic constraints.
- Associated unit tests with `@siglo/testing` mock providers.

---

## 3. Visual DevTools Inspectors

Siglo's Live DevTools (web dashboard and terminal UI) will feature specialized inspector tabs when ecosystem steps are detected in the execution AST:

```
+-----------------------------------------------------------------------------------------+
|  Siglo DevTools - Execution Inspector                                                   |
+-----------------------------------------------------------------------------------------+
| [Overview]  [Context Diffs]  [★ HTTP]  [★ Crypto]  [★ Notifications]  [★ AI / LLM]      |
+-----------------------------------------------------------------------------------------+
|                                                                                         |
|  Step: callStripe (httpStep)                                                            |
|  - URL: POST https://api.stripe.com/v1/charges                                          |
|  - Status: 200 OK (Attempt 2 - Retry after 429)                                        |
|  - Duration: 242ms (Total including retry delay: 1,450ms)                               |
|  - W3C Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736                                       |
|  - Egress Policy: ASL ALLOWED (api.stripe.com matched allowlist)                         |
|                                                                                         |
|  [ Request Headers ]  [ Request Body ]  [ Response Body ]  [ cURL Snippet ]             |
+-----------------------------------------------------------------------------------------+
```

### 3.1 Specialized Inspector Panels

| Step Type | DevTools Inspector Features |
|---|---|
| **HTTP (`@siglo/http`)** | Request/response headers, raw JSON bodies, formatted `cURL` copy button, retry attempt waterfall with `Retry-After` metrics, and ASL network policy status. |
| **Crypto (`@siglo/crypto`)** | Signature verification diagnosis, timing-safe evaluation metrics, and toggleable field masking (redacting sensitive PII in public UI modes). |
| **Notifications (`@siglo/notifications`)** | Rendered preview of HTML emails or Slack Block Kit messages, status of interactive callback tokens, and durable wait countdown. |
| **AI (`@siglo/ai`)** | Prompt message timeline (System/User/Assistant), raw output vs parsed schema JSON diff, token cost breakdown, and self-healing repair loop attempts. |

---

## 4. Deterministic Testing & Replay Fixtures

Extend `@siglo/testing` with standard mock fixtures for offline CI/CD execution:

```typescript
import { createTestHarness } from '@siglo/testing';
import { mockHttpProvider } from '@siglo/http/testing';
import { mockAiProvider } from '@siglo/ai/testing';
import { mockNotificationTransport } from '@siglo/notifications/testing';
import { myEcosystemFlow } from './myFlow';

it('executes full pipeline deterministically with zero network calls', async () => {
  const harness = createTestHarness(myEcosystemFlow, {
    providers: [
      mockHttpProvider({
        'POST https://api.stripe.com/v1/charges': { status: 200, body: { chargeId: 'ch_123' } },
      }),
      mockAiProvider({
        assessLoan: {
          riskLevel: 'LOW',
          confidenceScore: 0.95,
          recommendedAction: 'APPROVE',
        },
      }),
      mockNotificationTransport(),
    ],
  });

  const result = await harness.run({ customerId: 'cust_99' });
  expect(result.chargeId).toBe('ch_123');
  expect(result.recommendedAction).toBe('APPROVE');
});
```

---

## 5. Phase 4 Checklist & Deliverables

- [ ] CLI step generation templates in `@siglo/cli`:
  - [ ] `generate:step --type http`
  - [ ] `generate:step --type crypto`
  - [ ] `generate:step --type notification`
  - [ ] `generate:step --type ai`
- [ ] DevTools UI custom inspectors:
  - [ ] HTTP Request/Response & cURL panel.
  - [ ] Webhook signature verification & field mask visualizer.
  - [ ] Interactive notification & Slack block renderer.
  - [ ] LLM prompt inspector, token cost counter, and repair loop visualizer.
- [ ] Unified offline mock providers exported via `@siglo/testing`.
- [ ] End-to-end integration examples and cookbook documentation.
