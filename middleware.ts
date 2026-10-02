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
 * common way a bundle ends up executing attacker-supplied source. It IS present
 * in development only, because React Fast Refresh and the dev overlay genuinely
 * require it, and a dev-only allowance cannot affect a production deployment.
 *
 * ---------------------------------------------------------------------------
 * WHY `connect-src` INCLUDES THE FIREBASE HOSTS EXPLICITLY
 * ---------------------------------------------------------------------------
 * Firebase Auth, Firestore, and Storage talk to specific origins. Without them
 * here the browser blocks every sign-in attempt and the failure looks like a
 * broken product rather than a policy problem. The list is explicit rather than
 * `https:` because a wildcard here would permit exfiltration to any host, which
 * is the same class of mistake as `'unsafe-inline'`.
 *
 * `wss://*.firebaseio.com` is present because Firestore's realtime transport is
 * a WebSocket, and the realtime listeners in docs/11 are half the product.
 *
 * ---------------------------------------------------------------------------
 * WHY GOOGLE MAPS IS **NOT** IN THIS POLICY
 * ---------------------------------------------------------------------------
 * An earlier revision of this file pre-declared `maps.googleapis.com` and
 * `maps.gstatic.com` in `script-src`, `img-src`, `frame-src` and `connect-src`,
 * on the reasoning that a CSP is enforced against code that does not exist yet
 * so declaring a host early is free.
 *
 * That reasoning was wrong in this case, and the cost was concrete:
 *   - The browser never loads the Google Maps JavaScript API. Nothing in this
 *     repository imports it, injects a `<script>` for it, or references
 *     `window.google`. The only map component, `features/analytics/risk-map.tsx`,
 *     dynamically imports **Mapbox GL** (`mapbox-gl`), which is bundled by
 *     webpack and served from our own origin.
 *   - `services/maps/reverse-geocode.ts` does call the Geocoding REST API, but
 *     it does so **server-side** through `lib/env.server.ts`. A server-to-server
 *     fetch is not governed by the browser's CSP, so no directive here can
 *     enable or block it.
 *   - With `'strict-dynamic'` present in `script-src`, browsers ignore host
 *     allowlists in that directive entirely. So the Maps entries in `script-src`
 *     were not "pre-declared for later" — they were inert text that implied the
 *     policy had been reviewed for Maps and never was.
 *
 * `https://maps.googleapis.com` is also removed from `connect-src` because
 * `https://*.googleapis.com` already matches it; the explicit entry was
 * redundant. Firebase's own origins are kept and are listed for real.
 */

/**
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
    // -------------------------------------------------------------------------
    // `script-src` — HOW THE NONCE REACHES THE SCRIPTS
    // -------------------------------------------------------------------------
    // `'strict-dynamic'` lets a nonce'd script load the rest of the bundle
    // without allow-listing every chunk hash, which Next.js cannot provide
    // statically.
    //
    // Its cost, which is why this is written down rather than assumed: when a
    // policy contains `'strict-dynamic'` alongside a nonce or a hash, browsers
    // **ignore** the host allowlists and `'self'` in this directive. Only scripts
    // that carry the nonce, and scripts those scripts load, are permitted.
    //
    // That is precisely why the nonce has to reach Next.js (see `middleware`).
    // If it does not, every `<script>` Next emits — the inline flight-data
    // bootstrap AND the `/_next/static/chunks/<hash>.js` tags — is un-nonced, `'self'`
    // is ignored, and the entire client bundle is refused. The page keeps
    // whatever the server rendered, which for this app is the auth loading
    // state, and so it spins forever.
    //
    // No Google Maps origin appears here: no Maps JavaScript API is loaded.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`.trim(),
    // `script-src-attr` blocks inline event handlers (`onclick="..."`), which a
    // nonce cannot cover. React attaches listeners as properties, not attributes,
    // so this breaks nothing in this app.
    "script-src-attr 'none'",
    // `style-src` needs 'unsafe-inline': Tailwind and Radix both set inline
    // styles for dynamic values (a marker's position, a progress bar's width).
    // This is a real, accepted limitation, documented in docs/10 §14.2 — and it
    // is far less dangerous than `script-src 'unsafe-inline'`, because CSS
    // cannot execute script in any modern browser.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // Explicit hosts, not `https:`. An evidence image comes from Firebase
    // Storage and an avatar from Google — and nothing else has any business
    // being loaded as an image. The Maps origins were removed; see the note
    // above on why Google Maps is not in this policy at all.
    "img-src 'self' blob: data: https://*.googleusercontent.com https://firebasestorage.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // A voice report is recorded in the browser and previewed from a blob before
    // upload, so `blob:` is required here and is not a hole: nothing is loaded
    // from it that the app did not just create.
    "media-src 'self' blob: https://firebasestorage.googleapis.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://www.googleapis.com https://firestore.googleapis.com https://firebasestorage.googleapis.com",
    // Google sign-in opens a POPUP (a new top-level window, not an iframe), and
    // the Firebase Auth iframe flow is served from the project's own domain.
    // Both are listed so the Google provider keeps working under this policy;
    // neither is a script source.
    "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com",
    // A Firestore listener and the map both run their work off the main thread.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // The CSP half of the CSRF defence. `form-action 'self'` means a form
    // injected into our own DOM cannot POST to an attacker's origin even if it
    // somehow bypassed `assertSameOrigin`.
    "form-action 'self'",
    "frame-ancestors 'none'",
    isDev ? '' : 'upgrade-insecure-requests',
  ].filter(Boolean);

  return directives.join('; ');
}

/**
 * The routes that must never be indexed, and the reason.
 *
 * A private operations console appearing in a search result is a disclosure
 * before a single rule is evaluated. `/admin` and the incident screens are listed
 * explicitly rather than by pattern so a new page has to be added deliberately.
 */
function robotsTag(pathname: string): string | null {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'noindex, nofollow';
  if (pathname === '/dashboard' || pathname.startsWith('/incidents')) return 'noindex, nofollow';
  if (pathname === '/map' || pathname === '/responders' || pathname === '/dispatches') {
    return 'noindex, nofollow';
  }
  return null;
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

    // No Referer path. `strict-origin-when-cross-origin` sends the ORIGIN to a
    // third party and the full URL only to our own origin, so a report
    // reference in the path never reaches an external host.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    /**
     * `camera`, `microphone`, and `geolocation` are `(self)` — ALLOWED — and
     * this is a Phase 2 bug fix, not a stylistic choice.
     *
     * The previous value was `camera=(), microphone=()`, which blocks the two
     * capabilities the product is built on: `ENABLE_VOICE_REPORTING` (FR-009)
     * and image evidence (FR-005) could never have worked in a browser, and
     * geolocation was already `(self)` because the map needed it. Every other
     * feature is denied outright rather than `()`, so a future addition has to
     * be a deliberate edit rather than an inherited permission.
     */
    'Permissions-Policy':
      'geolocation=(self), camera=(self), microphone=(self), fullscreen=(self), payment=(), usb=(), bluetooth=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=(), autoplay=(), interest-cohort=()',

    /**
     * REQUIRED for Google sign-in to work at all.
     *
     * `signInWithPopup` (the `google` provider is enabled, docs/10 §3.1) opens
     * a cross-origin window and needs to read its handle to complete the flow.
     * The browser's default `same-origin` COOP severs that handle, so the popup
     * closes and the user sees a failed sign-in with nothing in the console to
     * explain it. `same-origin-allow-popups` keeps the opener's isolation for
     * every other relationship and relaxes exactly this one. docs/10 §15.1.
     */
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',

    // Nothing this app loads is meant to be embedded by another origin. This is
    // the resource-side companion to `frame-ancestors 'none'`.
    'Cross-Origin-Resource-Policy': 'same-origin',

    // HSTS. Only meaningful over HTTPS, which `lib/env.server.ts` enforces for a
    // production build. `preload` is NOT set: submitting a domain to the preload
    // list is effectively irreversible and should be a separate, deliberate act.
    'Strict-Transport-Security': isDev ? 'max-age=0' : 'max-age=31536000; includeSubDomains',

    'X-Request-Id': request.headers.get('x-request-id') ?? '',

    // NOTE: `x-csp-nonce` used to be set here, on the RESPONSE, in production
    // only. It was dead weight twice over — Next.js does not read that header,
    // and a response header cannot reach the render that emits the scripts it
    // was meant to authorise. The nonce is delivered on the REQUEST instead;
    // see below.
  };

  // An empty header is worse than no header: some intermediaries treat an empty
  // value as a malformed instruction. Only set the id when we have one.
  if (headers['X-Request-Id'] === '') delete headers['X-Request-Id'];

  const robots = robotsTag(request.nextUrl.pathname);
  if (robots !== null) headers['X-Robots-Tag'] = robots;

  const requestHeaders = new Headers(request.headers);

  /**
   * ---------------------------------------------------------------------------
   * THE ACTUAL FIX FOR THE STUCK-ON-LOADING PAGE
   * ---------------------------------------------------------------------------
   * Next.js discovers a per-request CSP nonce by PARSING THE NONCE OUT OF THE
   * `Content-Security-Policy` HEADER ON THE REQUEST**. That is the only channel
   * it reads. `x-nonce` and `x-csp-nonce` are not consulted for script
   * noncing.
   *
   * So this middleware set the policy on the response only, Next never learned
   * a nonce, and therefore stamped `nonce` on none of its `<script>` elements.
   * Combined with `'strict-dynamic'` — under which browsers ignore `'self'` and
   * every host allowlist in `script-src` — the consequence is total: the inline
   * flight-data bootstrap AND every `/_next/static/chunks/<hash>.js` tag were refused.
   * No JavaScript ran, React never hydrated, and the page sat on whatever the
   * server had painted: the auth loading state. Forever.
   *
   * Setting the same `csp` string on the request headers makes Next apply the
   * nonce to its own bootstrap AND to the chunk tags it emits, which is exactly
   * what `'strict-dynamic'` needs in order to trust the rest of the graph. The
   * response keeps the same policy so the browser enforces it.
   *
   * It is set in development too, deliberately. The previous build sent no
   * nonce header at all when `NODE_ENV !== 'production'`, which meant the dev
   * server could never have reproduced this bug locally — the failure only
   * appeared once deployed. `npm run build && npm start` is the honest test.
   */
  requestHeaders.set('Content-Security-Policy', csp);

  /**
   * Exposed for application code that genuinely must render an inline script,
   * so it can read the SAME per-request nonce instead of inventing one. Nothing
   * in this repository currently renders an inline `<script>`; this exists so a
   * future one has no excuse to reach for `'unsafe-inline'`.
   */
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
