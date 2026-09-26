/**
 * ============================================================================
 * CareGrid AI — the Twilio integration
 * ============================================================================
 *
 * The ONE file that reads `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
 * `TWILIO_WHATSAPP_NUMBER`.
 *
 * ---------------------------------------------------------------------------
 * WHY SMS AND WHATSAPP ARE OFF, AND WHY THE UI SAYS SO
 * ---------------------------------------------------------------------------
 * FR-105 (SMS) and FR-106 (WhatsApp) require a preference the user can set. Both
 * providers need a paid account, a Meta business verification for WhatsApp, and
 * a sender registration that takes days. The project therefore ships:
 *
 *   - `ENABLE_SMS_NOTIFICATIONS=false` and `ENABLE_WHATSAPP_NOTIFICATIONS=false`
 *   - `PATCH /api/me` REFUSING `notifPrefs.sms: true` and `.whatsapp: true` with
 *     `422 NOTIFICATION_DISABLED`, naming the field (docs/30.3 §A6.1);
 *   - `GET /api/me` FORCING both to `false` in the response, so a document
 *     written by any other path still reports the truth; and
 *   - the profile switches rendered DISABLED WITH A REASON rather than hidden.
 *
 * A stored preference the system cannot honour is worse than not offering it:
 * it looks saved and then silently fails on every send, which is the failure
 * mode a user cannot debug (docs/13 §12).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS IN PHASE 3
 * ---------------------------------------------------------------------------
 * A complete, honest, NON-FUNCTIONAL adapter. `isAvailable()` is `false`,
 * `send()` throws, and no message is transmitted. docs/32 MUST 7 forbids a
 * `if (import.meta.env.DEV) return { ok: true }` data path inside a feature, so
 * there is no branch anywhere here that could make a send "succeed" without a
 * provider.
 *
 * ---------------------------------------------------------------------------
 * WHAT PHASE 9 ADDS, AND ONLY HERE
 * ---------------------------------------------------------------------------
 * The `twilio` SDK, one `client.messages.create()` per channel, the documented
 * `dedupeKey` so one notification is one message (FR-108), the retry policy
 * bounded by `NOTIFICATION_RETRY_LIMIT`, and the honest cost note in docs/13
 * §12 — SMS is billed per segment and WhatsApp is billed per conversation, so a
 * flood is a bill.
 *
 * The `NotificationChannel` interface is in `lib/integrations/contracts.ts`, so
 * the in-app channel and these two are interchangeable from a service's point of
 * view. A service never learns which one it holds.
 */

import 'server-only';

import { AppError } from '@/lib/server/errors';
import { twilioConfig, twilioStatus, type IntegrationStatus } from '@/lib/env.server';
import type {
  NotificationChannel,
  ProviderCallOptions,
  ProviderStatus,
} from '@/lib/integrations/contracts';

/* ========================================================================== */
/* SMS                                                                         */
/* ========================================================================== */

class UnconfiguredSmsChannel implements NotificationChannel {
  readonly channel = 'sms' as const;

  isAvailable(): boolean {
    return false;
  }

  async send(
    _message: { readonly to: string; readonly body: string; readonly idempotencyKey: string },
    _options: ProviderCallOptions,
  ): Promise<{ readonly providerMessageId: string | null }> {
    throw disabled('SMS');
  }
}

/* ========================================================================== */
/* WhatsApp                                                                   */
/* ========================================================================== */

class UnconfiguredWhatsAppChannel implements NotificationChannel {
  readonly channel = 'whatsapp' as const;

  isAvailable(): boolean {
    return false;
  }

  async send(
    _message: { readonly to: string; readonly body: string; readonly idempotencyKey: string },
    _options: ProviderCallOptions,
  ): Promise<{ readonly providerMessageId: string | null }> {
    throw disabled('WhatsApp');
  }
}

/* ========================================================================== */
/* Shared                                                                      */
/* ========================================================================== */

/**
 * `422`, not `503` and not `502`.
 *
 * The request was well-formed, the channel is a real capability, and the
 * deployment has it switched off. That is a permanent answer about this
 * deployment, so a client must not retry it — and a 503 or a 502 would make a
 * well-behaved client retry a send that can never succeed.
 */
function disabled(channel: string): AppError {
  return new AppError({
    code: 'NOTIFICATION_DISABLED',
    message: `${channel} notifications are not available: no provider is configured in this deployment.`,
  });
}

const CACHE_KEY = '__caregrid_twilio_channels_v1__';
type GlobalWithChannels = typeof globalThis & { [CACHE_KEY]?: NotificationChannel[] };

/**
 * Every external channel, in the order a service should try them.
 *
 * `in_app` is NOT here. It is server-owned — a Firestore write, not a provider
 * call — and it is the only channel that always works, so it is handled by
 * `services/notifications/` directly rather than through this abstraction. This
 * list is the set of channels that can FAIL, which is the set that needs an
 * interface.
 */
export function getExternalChannels(): readonly NotificationChannel[] {
  const cache = globalThis as GlobalWithChannels;
  const existing = cache[CACHE_KEY];
  if (existing) return existing;
  const channels: NotificationChannel[] = [
    new UnconfiguredSmsChannel(),
    new UnconfiguredWhatsAppChannel(),
  ];
  cache[CACHE_KEY] = channels;
  return channels;
}

export function resetChannelsForTests(): void {
  delete (globalThis as GlobalWithChannels)[CACHE_KEY];
}

export function providerStatus(): ProviderStatus {
  const status: IntegrationStatus = twilioStatus();
  return {
    provider: 'twilio',
    configured: status.configured,
    requiredVars: status.required,
    problem: status.problem,
  };
}

/**
 * Which channels this deployment can actually deliver on.
 *
 * `in_app` is `true` unconditionally and is NOT dependent on Twilio, which is
 * the point: turning off SMS must not turn off in-app notifications. A
 * notification service asks this and gets `['in_app']` in Phase 3, so every
 * user-visible notification still works.
 */
export function availableChannels(): readonly NotificationChannel['channel'][] {
  const available: NotificationChannel['channel'][] = ['in_app'];
  for (const channel of getExternalChannels()) {
    if (channel.isAvailable()) available.push(channel.channel);
  }
  return available;
}

/** The non-secret flags, for the admin health endpoint. */
export function twilioSettings() {
  const config = twilioConfig();
  return {
    smsEnabled: config.smsEnabled,
    whatsappEnabled: config.whatsappEnabled,
    retryLimit: config.retryLimit,
    /** Present/absent only. The value is never returned. */
    whatsappNumberConfigured: config.whatsappNumber !== '',
  };
}
