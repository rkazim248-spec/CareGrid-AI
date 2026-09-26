import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ============================================================================
 * The security response headers
 * ============================================================================
 *
 * `middleware.ts` is not exercised by any other suite — it runs in the Edge
 * runtime and needs a running server. So its properties are asserted from the
 * SOURCE, which is the level at which a mistake is actually made: editing a
 * directive string.
 *
 * Three of these assertions are Phase 2 bug fixes, found while building Phase 3
 * and recorded here so they cannot be reverted:
 *
 *   1. `Permissions-Policy` had `camera=(), microphone=()`. That blocks
 *      `ENABLE_VOICE_REPORTING` (FR-009) and image evidence (FR-005) at the
 *      browser, permanently, for reasons invisible in the code that uses them.
 *      Both are now `(self)`.
 *   2. `Cross-Origin-Opener-Policy` was ABSENT. Its browser default is
 *      `same-origin`, which severs the window handle `signInWithPopup` needs, so
 *      Google sign-in was broken under a policy nobody had added yet.
 *   3. `img-src` was `https:`, which permits loading an image from ANY host —
 *      the same class of mistake as `'unsafe-inline'`, in a directive where the
 *      real list is short and knowable.
 */

const ROOT = join(process.cwd());
const raw = readFileSync(join(ROOT, 'middleware.ts'), 'utf8');

/**
 * The source with every comment removed.
 *
 * Assertions about what the middleware DOES must run against code, not prose.
 * The file's own documentation explains at length why it reads no cookie and
 * performs no redirect, so a naive `not.toContain('cookies')` fails on the
 * comment that documents the absence. Stripping comments first is what makes
 * these assertions about behaviour.
 */
const source = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\/.*$/gm, '');


/**
 * One directive's value, e.g. `object-src` -> `'none'`.
 *
 * The value itself contains single quotes, so the capture runs to the next DOUBLE
 * quote. Every simple directive in this file is a double-quoted string literal,
 * so that is unambiguous. Reading the RAW source (not the comment-stripped one) is
 * deliberate: the directive strings ARE the thing under test.
 */
function directive(name: string): string {
  // Anchored to the start of a LINE inside the directive array. Without the
  // anchor the regex also matches the file's own prose, which discusses
  // `form-action 'self'` and `frame-ancestors 'none'` in comments.
  const match = raw.match(new RegExp(`^\\s*["'\`]${name} ([^"]*)["'\`],`, 'm'));
  return match?.[1]?.trim() ?? '';
}

describe('the header set', () => {
  const REQUIRED: Array<[header: string, why: string]> = [
    ['Content-Security-Policy', 'the primary XSS control'],
    ['X-Content-Type-Options', 'a .txt served as text/html is a stored-XSS primitive'],
    ['X-Frame-Options', 'the only instruction a very old browser honours'],
    ['Referrer-Policy', 'a report reference must not leak to a third party'],
    ['Permissions-Policy', 'camera, microphone, and geolocation are product features'],
    ['Cross-Origin-Opener-Policy', 'REQUIRED for signInWithPopup to complete'],
    ['Cross-Origin-Resource-Policy', 'nothing here is meant to be embedded elsewhere'],
    ['Strict-Transport-Security', 'only meaningful over HTTPS'],
  ];

  for (const [header, why] of REQUIRED) {
    it(`sets ${header}, because ${why}`, () => {
      expect(source, `${header} is not set`).toContain(`'${header}'`);
    });
  }

  it('sets X-Robots-Tag on the operational routes only', () => {
    // A private operations console appearing in a search result is a disclosure
    // before a single rule is evaluated.
    expect(source).toContain('X-Robots-Tag');
    expect(source).toContain("'/admin'");
    expect(source).toContain('noindex, nofollow');
  });
});

describe('the CSP has no script injection surface', () => {
  it("script-src has NO 'unsafe-inline' outside development", () => {
    // `'unsafe-inline'` would let ANY injected `<script>` tag run, which defeats
    // the point of having a CSP at all. Next emits its own bootstrap scripts
    // with nonces, which is why this is safe.
    const line = raw
      .split('\n')
      .find((l) => /^\s*`?script-src /.test(l));
    expect(line, 'script-src directive not found').toBeDefined();
    // The dev-only allowance is stripped, then the production string is checked.
    const production = String(line).replace("'unsafe-eval'", '');
    expect(production, "script-src must never contain 'unsafe-inline'").not.toContain('unsafe-inline');
  });

  it("script-src is nonce-based and carries 'strict-dynamic'", () => {
    expect(raw).toContain("'nonce-${nonce}'");
    // `strict-dynamic` lets a nonce'd script load the rest of the bundle without
    // allow-listing every chunk hash, which Next cannot provide statically.
    expect(raw).toContain("'strict-dynamic'");
  });

  it("script-src-attr is 'none', which blocks inline event handlers", () => {
    // A nonce cannot cover an inline `onclick`. React attaches listeners as
    // properties, not attributes, so this breaks nothing in this app.
    expect(directive('script-src-attr')).toBe("'none'");
  });

  it("object-src is 'none' and base-uri is 'self'", () => {
    expect(directive('object-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'self'");
  });

  it("form-action is 'self', which is the CSP half of the CSRF defence", () => {
    // A form injected into our own DOM cannot POST to an attacker's origin even
    // if it somehow bypassed `assertSameOrigin`.
    expect(directive('form-action')).toBe("'self'");
  });

  it("frame-ancestors is 'none', so a dispatcher's confirm click cannot be hijacked", () => {
    expect(directive('frame-ancestors')).toBe("'none'");
  });
});

describe('the CSP does not break the integrations', () => {
  /**
   * The brief is explicit: "Do not break Firebase, Maps, or other future
   * integrations with an unnecessarily restrictive policy." A policy that is too
   * tight fails as an unexplained product bug, and the console message names a
   * directive, not a feature.
   */
  const REQUIRED_HOSTS: Array<[directive: string, host: string, why: string]> = [
    ['connect-src', 'firestore.googleapis.com', 'every Firestore read and write'],
    ['connect-src', 'identitytoolkit.googleapis.com', 'every sign-in attempt'],
    ['connect-src', 'securetoken.googleapis.com', 'token refresh, so a session survives an hour'],
    ['connect-src', 'wss://*.firebaseio.com', 'the realtime listeners in docs/11'],
    ['connect-src', 'firebasestorage.googleapis.com', 'evidence images, Phase 5'],
    ['script-src', 'maps.googleapis.com', 'the Maps JavaScript API, Phase 6'],
    ['img-src', 'firebasestorage.googleapis.com', 'an evidence image from a signed URL'],
    ['frame-src', 'accounts.google.com', 'the Google sign-in flow'],
    ['frame-src', '*.firebaseapp.com', 'the Firebase Auth iframe flow'],
    ['media-src', 'blob:', 'previewing a recorded voice report before upload'],
  ];

  for (const [name, host, why] of REQUIRED_HOSTS) {
    it(`${name} allows ${host}, for ${why}`, () => {
      const line = raw
        .split('\n')
        .find((l) => new RegExp(`^\\s*["'\`]${name} `).test(l));
      expect(line, `${name} directive not found`).toBeDefined();
      expect(line, `${name} must allow ${host}`).toContain(host);
    });
  }

  it('img-src is an explicit host list, NOT `https:`', () => {
    // A wildcard in `img-src` permits exfiltration to any host, which is the
    // same class of mistake as `'unsafe-inline'`. The real list is short and
    // knowable, so there is no reason to be vague.
    const line = raw.split('\n').find((l) => /^\s*"img-src /.test(l));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/img-src[^"]*https:\s*$/);
    expect(line).not.toMatch(/img-src[^"]*\shttps:[;"]/);
  });

  it('AI Studio is NOT in connect-src, because it is server-side only', () => {
    // Gemini is reached from the server. A browser that could reach it would mean
    // the key was in the bundle.
    const line = raw.split('\n').find((l) => /^\s*"connect-src /.test(l));
    expect(line).not.toMatch(/aiplatform|generativelanguage/);
  });

  it('no `report-uri` is declared, because the endpoint does not exist', () => {
    // docs/10 §15.2 specifies `report-uri /api/cron/csp-report`, which is gated by
    // CRON_SECRET and lands in Phase 9. Declaring a report-uri now would point
    // every browser at a 404 on every page. Recorded in
    // `docs/34_BACKEND_INTEGRATION_POINTS.md` as a TODO with its exact text.
    const line = raw.split('\n').find((l) => /^\s*"connect-src /.test(l));
    expect(line).not.toContain('report-uri');
  });
});

describe('the Permissions-Policy grants what the product needs', () => {
  const value = source.match(/'Permissions-Policy':\s*\n?\s*'([^']+)'/)?.[1] ?? '';

  it('allows geolocation, camera, and microphone from this origin', () => {
    // The Phase 2 bug: `camera=(), microphone=()` permanently blocked
    // `ENABLE_VOICE_REPORTING` (FR-009) and image evidence (FR-005) at the
    // browser, for reasons invisible in the code that uses them.
    expect(value).toContain('geolocation=(self)');
    expect(value).toContain('camera=(self)');
    expect(value).toContain('microphone=(self)');
  });

  it('denies every other capability outright, so a future one is a deliberate edit', () => {
    for (const denied of ['payment=()', 'usb=()', 'bluetooth=()', 'midi=()', 'accelerometer=()', 'gyroscope=()', 'magnetometer=()', 'display-capture=()', 'autoplay=()']) {
      expect(value, `${denied} should be denied`).toContain(denied);
    }
  });
});

describe('the middleware is not a security control, and does not pretend to be', () => {
  it('performs no authentication and no session redirect', () => {
    // There is NO session cookie in this product (docs/10 §12.1), so there is
    // nothing at the Edge to read. And the authoritative role lives in
    // `users/{uid}.role`, which the Firestore Admin SDK cannot read on the Edge
    // runtime. A middleware that redirected on an unverifiable cookie would be a
    // control that LOOKS like one, which is worse than none.
    expect(source).not.toContain('cookies');
    expect(source).not.toContain('NextResponse.redirect');
    expect(source).not.toContain('getSession');
    expect(source).not.toContain('verifyIdToken');
    // The only NextResponse call is the pass-through.
    expect((source.match(/NextResponse\./g) ?? [])).toHaveLength(1);
    expect(source).toContain('NextResponse.next');
  });

  it('excludes `api` from the matcher, so a header failure cannot affect the API', () => {
    // docs/05 §9.7. The API sets its own headers and does its own `requireUser`.
    const matcher = source.match(/matcher: \[([\s\S]*?)\]\s*,?\s*\};/)?.[1] ?? '';
    expect(matcher).toContain('api');
    expect(matcher).toMatch(/api\|_next/);
  });
});
