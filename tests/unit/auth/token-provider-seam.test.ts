import { describe, expect, it } from 'vitest';
import { apiFetch, clearTokenProvider, setTokenProvider } from '@/lib/api/client';

/**
 * The production signup/session defect, locked down.
 *
 * `SessionProvider` installs its token seam once, from an effect whose
 * dependencies (`configurationProblem`, `defaultTimezone`, `loadMe`) do not
 * change on sign-out or sign-in. `handleSignOut` used to call
 * `clearTokenProvider()` while the provider was still mounted, so the slot
 * stayed `null` for the remainder of the mount and was never reinstalled. Every
 * later authenticated request then threw
 *
 *   "The session layer is not ready yet. Wait for the page to finish loading."
 *
 * which the session gate renders as "We could not load this data". It only
 * appeared on a sign-out -> sign-in cycle that did not reload the page, which is
 * why it looked intermittent and never surfaced in a fresh-page-load test.
 */

function okEnvelope(data: unknown, requestId: string): string {
  return JSON.stringify({ success: true, data, meta: { requestId } });
}

describe('token provider seam', () => {
  it('reports the signed-out message, not "not ready", when the seam yields null', async () => {
    clearTokenProvider();

    // The seam stays installed across sign-out and returns null, exactly as
    // `getIdToken(false)` does once Firebase has no user.
    setTokenProvider(async () => null);

    await expect(apiFetch('/api/me')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
      requestId: 'req_signed_out',
      message: 'Sign in to continue.',
    });
  });

  it('sends the bearer token after a tear-down and reinstall', async () => {
    clearTokenProvider();
    setTokenProvider(async () => 'token-after-reinstall');

    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { headers?: HeadersInit }) => {
      calls.push(new Headers(init?.headers).get('Authorization') ?? '');
      return new Response(okEnvelope({ user: { status: 'active' } }, 'req_seam00000001'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      await apiFetch('/api/me');
      expect(calls).toEqual(['Bearer token-after-reinstall']);
    } finally {
      globalThis.fetch = originalFetch;
      clearTokenProvider();
    }
  });

  it('reports "not ready" only when no seam is installed at all', async () => {
    clearTokenProvider();

    await expect(apiFetch('/api/me')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      requestId: 'req_unregistered',
      message: 'The session layer is not ready yet. Wait for the page to finish loading.',
    });
  });

  it('leaves anonymous requests unaffected when no seam is installed', async () => {
    clearTokenProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(okEnvelope({ ok: true }, 'req_seam00000002'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      await expect(apiFetch('/api/health', { anonymous: true })).resolves.toMatchObject({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});