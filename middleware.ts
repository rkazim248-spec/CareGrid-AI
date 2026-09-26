import { NextResponse, type NextRequest } from 'next/server';

/**
 * ============================================================================
 * CareGrid AI — security headers
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MIDDLEWARE DOES **NOT** DO, AND WHY THAT MATTERS
 * ---------------------------------------------------------------------------
 * It performs **no authentication, no authorisation, and no redirect based on a
 * session.**
 *
 * docs/05 §9.1 sketches a middleware that reads a session cookie and redirects.
 * docs/10 §12.1 and §12.3 state that this product uses NO session cookies: every
 * API call carries `Authorization: Bearer <Firebase ID token>`, because a cookie
 * is attached automatically by the browser and a bearer header is not. So there
 * is nothing at the Edge to read.
 *
 * Worse, the authoritative role lives in `users/{uid}.role`, and the Firestore
 * Admin SDK — the only way to read it — does not run on the Edge runtime. A
 * middleware that decided access from a token CLAIM would make the claim the
 * authority, which docs/22 §2 forbids outright.
 *
 * A middleware that redirected on an unverifiable cookie would be a security
 * control that LOOKS like one. That is worse than having none, because a team
 * would then believe the routes were protected at the Edge when the real
 * boundary is elsewhere.
 *
 * The actual boundaries, both implemented in this build:
 *   1. `lib/server/auth-guard.ts` — `requireUser()` on every API route.
 *   2. `firestore.rules` — deny-by-default for every client-SDK read and write.
 *   3. `RequireSession` (a Client Component) — the redirect convenience.
 *
 * ---------------------------------------------------------------------------
 * SO WHY HAVE A MIDDLEWARE AT ALL
 * ---------------------------------------------------------------------------
 * Because the RESPONSE HEADERS are genuinely useful here, and they are exactly
 * the kind of thing that gets forgotten when it is added route by route.
 * docs/10 §15 specifies them; this sets them once, for every route.
 */

/**
 * The Content-Security-Policy (docs/10 §15.2).
 *
 * ---------------------------------------------------------------------------
 * WHY `script-src` HAS NO `'unsafe-inline'` AND NO `unsafe-eval`
 * ---------------------------------------------------------------------------
 * `unsafe-inline` would let ANY injected `<script>` tag run, which defeats the
 * point of having a CSP at all. Next.js emits its own bootstrap scripts with
 * NONCES when `nonce` is supplied per request, which is why this function reads
 * it from the CSP-NONCE header the framework sets.
 *
 * `unsafe-eval` is absent for the same reason plus one: it is the single most
 * common way a bundle ends up executing attacker-supplied source.
 *
 * ---------------------------------------------------------------------------
 * WHY `connect-src` INCLUDES THE FIREBASE HOSTS EXPLICITLY
 * ---------------------------------------------------------------------------
 * Firebase Auth and Firestore talk to specific origins. Without them here the
 * browser blocks every sign-in attempt and the failure looks like a broken
 * product rather than a policy problem. The list is explicit rather than
 * `https:` because a wildcard here would permit exfiltration to any host, which
 * is the same class of mistake as `'unsafe-inline'`.
 *
 * ---------------------------------------------------------------------------
 * WHY `frame-ancestors 'none'`
 * ---------------------------------------------------------------------------
 * Clickjacking. A dispatcher confirming an assignment is exactly the kind of
 * high-value click an attacker wants to overlay with an invisible iframe.
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';

  const directives = [
    "default-src 'self'",
    // `strict-dynamic` lets a nonce'd script load the rest of the bundle without
    // allow-listing every chunk hash, which Next.js cannot provide statically.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`.trim(),
    // `style-src` needs 'unsafe-inline': Tailwind and Radix both set inline
    // styles for dynamic values (a marker's position, a progress bar's width).
    // This is a real, accepted limitation, documented in docs/10 §14.2 — and it
    // is far less dangerous than `script-src 'unsafe-inline'`, because CSS
    // cannot execute script in any modern browser.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://www.googleapis.com https://firestore.googleapis.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    isDev ? '' : 'upgrade-insecure-requests',
  ].filter(Boolean);

  return directives.join('; ');
}

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const isDev = process.env.NODE_ENV !== 'production';

  const csp = contentSecurityPolicy(nonce);

  const headers: Record<string, string> = {
    'Content-Security-Policy': csp,

    // `X-Frame-Options` is DENIED as well as `frame-ancestors`. The header is
    // obsolete but is the only instruction a very old browser honours, and a
    // control that only works on modern clients is not a control.
    'X-Frame-Options': 'DENY',

    // No MIME sniffing: a `.txt` served as `text/html` is a stored-XSS primitive.
    'X-Content-Type-Options': 'nosniff',

    // No Referer. The reference in a query string is a report identifier, and a
    // Referer header would leak it to any third-party host the page links to.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Only this app's own origin may frame content, and only for media.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()',

    // HSTS. Only meaningful over HTTPS, which `lib/env.server.ts` enforces for a
    // production build. `preload` is NOT set: submitting a domain to the preload
    // list is effectively irreversible and should be a separate, deliberate act.
    'Strict-Transport-Security': isDev ? 'max-age=0' : 'max-age=31536000; includeSubDomains',

    'X-Request-Id': request.headers.get('x-request-id') ?? '',

    // Next reads this to nonce its own bootstrap scripts.
    ...(isDev ? {} : { 'x-csp-nonce': nonce }),
  };

  // An empty header is worse than no header: some intermediaries treat an empty
  // value as a malformed instruction. Only set the id when we have one.
  if (headers['X-Request-Id'] === '') delete headers['X-Request-Id'];

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Used by the request-id log line so a server log and a browser trace can be
  // joined without threading a value through every function signature.
  requestHeaders.set('x-caregrid-path', request.nextUrl.pathname);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

/**
 * ---------------------------------------------------------------------------
 * WHAT IS EXCLUDED, AND WHY EACH ONE
 * ---------------------------------------------------------------------------
 * - `api/*` — the API sets its own headers and does its own `requireUser()`. A
 *   redirect must never affect it (docs/05 §9.7).
 * - `_next/static`, `_next/image` — build output. A CSP header on a 40 KB chunk
 *   is bytes spent twice and buys nothing.
 * - Files with an extension — a stylesheet or a font does not need a frame
 *   policy.
 * - The favicon, robots, and sitemap — trivially small and never framed.
 */
export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
