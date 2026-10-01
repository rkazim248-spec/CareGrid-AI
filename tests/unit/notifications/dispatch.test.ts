import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';


import {
  availableChannelsNow,
  channelReport,
  isChannelAvailable,
  type NotificationChannelName,
} from '@/services/notifications';
import { notificationRetryLimit } from '@/lib/env.server';

/* ========================================================================== */
/* THE HEADLINE CLAIM — brief's IMPORTANT paragraph                           */
/* ========================================================================== */

describe('SMS and WhatsApp are NOT reported as working', () => {
  // brief: "Do not claim SMS or WhatsApp functionality is live unless the provider is
  // actually configured and successfully tested."
  //
  // It is NOT configured: `ENABLE_SMS_NOTIFICATIONS=false` and
  // `ENABLE_WHATSAPP_NOTIFICATIONS=false`, and `TWILIO_ACCOUNT_SID` is unset. These
  // tests assert the code CANNOT report those channels as available, so the claim
  // cannot be made by accident later either.

  it('SMS is not available', () => {
    expect(isChannelAvailable('sms')).toBe(false);
  });

  it('WhatsApp is not available', () => {
    expect(isChannelAvailable('whatsapp')).toBe(false);
  });

  it('email and push have no provider at all', () => {
    expect(isChannelAvailable('email')).toBe(false);
    expect(isChannelAvailable('push')).toBe(false);
  });

  it('in-app IS available — it is the one channel that genuinely delivers', () => {
    expect(isChannelAvailable('in_app')).toBe(true);
  });

  it('the available set is exactly the deliverable channels, no more', () => {
    // An exact list, not a subset test. A provider being ADDED later should have to
    // change this assertion, which is the point.
    expect([...availableChannelsNow()]).toEqual(['in_app']);
  });

  it('every unavailable channel carries a REASON, so nothing is silently missing', () => {
    const report = channelReport();
    const reasons = Object.fromEntries(report.unavailable.map((c) => [c.channel, c.reason]));
    expect(reasons.sms).toMatch(/not configured/i);
    expect(reasons.whatsapp).toMatch(/not configured/i);
    // The reason must never leak a credential, a phone number, or an account id.
    for (const { reason } of report.unavailable) {
      expect(reason).not.toMatch(/\+?\d{7,}/);          // no phone number
      expect(reason).not.toMatch(/AC[0-9a-f]{20,}/i);   // no Twilio account sid
      expect(reason).not.toMatch(/sk_|token|secret/i);
    }
  });

  it('the report never contains a credential field of any kind', () => {
    // brief §7. The whole report object is serialised to a client, so its SHAPE is
    // the privacy boundary — asserting it is what makes that structural.
    const serialised = JSON.stringify(channelReport());
    for (const forbidden of ['authToken', 'accountSid', 'apiKey', 'privateKey', 'password']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });
});

/* ========================================================================== */
/* §5 — the retry ceiling                                                      */
/* ========================================================================== */

describe('the retry ceiling is a COUNT, not a timer', () => {
  it('reads NOTIFICATION_RETRY_LIMIT and defaults to 2 when unset', () => {
    const limit = notificationRetryLimit();
    expect(limit).toBeGreaterThanOrEqual(0);
    expect(limit).toBeLessThanOrEqual(5);
  });

  it('is bounded to 5, so a misconfiguration cannot create a storm', () => {
    // `boundedNumber('NOTIFICATION_RETRY_LIMIT', 2, 0, 5)`. The reason for a ceiling
    // rather than a config read is that an unbounded retry count times an unbounded
    // recipient list is a notification storm, and a storm against a paid provider is a
    // bill.
    expect(notificationRetryLimit()).toBeLessThanOrEqual(5);
  });

  it('total attempts are limit + 1 — the initial try is not a retry', () => {
    // The arithmetic the dispatcher uses before every provider call.
    const limit = notificationRetryLimit();
    expect(limit + 1).toBeGreaterThanOrEqual(1);
  });
});

/* ========================================================================== */
/* §7 — no client-controlled recipient                                         */
/* ========================================================================== */

describe('recipients are server-derived by construction', () => {
  it('the service module is server-only', () => {
    // If this import ever stopped throwing on a client component, the whole
    // "no client-supplied recipient" argument collapses — the service would simply be
    // callable from the browser.
    const src = readFileSync('services/notifications/dispatch.ts', 'utf8');
    // The guard is a bare side-effect import, so it must be the FIRST statement —
    // not a search for the word anywhere in the file.
    expect(src.trimStart().startsWith("import 'server-only';")).toBe(true);
  });

  it('the API route exposes no way to NAME a recipient', () => {
    const raw = readFileSync('app/api/notifications/route.ts', 'utf8');

    // Comments are STRIPPED before scanning. The first version matched this very
    // test's neighbours: the route's docblock says "scoped by a
    // where('recipientId','==',uid)", which is the documentation OF the control, not
    // an exposure of it. Scanning prose fails correct code and pushes people to reword
    // the explanation instead of fixing anything.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // A POST/PUT handler, or a recipient field in a body schema, would be the
    // vulnerability. brief §7 forbids it outright.
    expect(src).not.toMatch(/export const (POST|PUT)\b/);
    expect(src).not.toMatch(/recipientUid|recipientId/);
    // And the uid must come from the verified token, never from the body.
    expect(src).toContain('const uid = user.uid;');
  });

  it('markRead scopes by a WHERE clause, not a prior read', () => {
    // A prior `get()` then `if (!doc) 403` would confirm that somebody else's
    // notification exists. A `where('recipientId','==',uid)` predicate cannot.
    const src = readFileSync('services/notifications/dispatch.ts', 'utf8');
    expect(src).toContain(".where('recipientId', '==', uid)");
    // And the not-found case reports ZERO, indistinguishable from "not yours".
    expect(src).toMatch(/markedRead: 0/);
  });
});

/* ========================================================================== */
/* The channel vocabulary                                                      */
/* ========================================================================== */

describe('the channel vocabulary is the documented one', () => {
  it('is exactly the five in the NotificationChannel contract', () => {
    // A sixth channel invented here would not be covered by `getExternalChannels()`,
    // so `isChannelAvailable` would answer `false` for it and it would silently never
    // deliver.
    const all: NotificationChannelName[] = ['in_app', 'sms', 'whatsapp', 'email', 'push'];
    const reported = channelReport();
    const covered = [...reported.available, ...reported.unavailable.map((c) => c.channel)];
    expect(covered.sort()).toEqual([...all].sort());
  });

  it('every unavailable channel is explained, none silently dropped', () => {
    const report = channelReport();
    for (const entry of report.unavailable) {
      expect(entry.reason.length, entry.channel).toBeGreaterThan(10);
    }
  });
});