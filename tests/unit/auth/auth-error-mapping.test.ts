/**
 * Firebase Auth error mapping and partial-signup recovery.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `mapAuthError` had no branch for any code in the Firebase *project
 * configuration* family, so all of them fell through to `default` and the user
 * was shown "Something went wrong. Try again." The header comment in
 * `lib/firebase/auth.ts` asserted the switch was exhaustive; it was not, and
 * that false claim is what allowed the gap to go unnoticed.
 *
 * The second half of this file covers a separate defect: `signUp` used one
 * `try` around both account creation and the cosmetic profile write, so a
 * failure of the second was reported as a failure of the first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';

import { AuthError, signIn, signInWithGoogle, signUp } from '@/lib/firebase/auth';

vi.mock('firebase/auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createUserWithEmailAndPassword: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    signInWithPopup: vi.fn(),
    updateProfile: vi.fn(),
  };
});

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseClient: () => ({ app: {}, auth: {}, db: {}, storage: {} }),
}));

/** A Firebase-shaped rejection: the SDK throws objects with a `code` field. */
function firebaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

const mockCreate = vi.mocked(createUserWithEmailAndPassword);
const mockSignIn = vi.mocked(signInWithEmailAndPassword);
const mockPopup = vi.mocked(signInWithPopup);
const mockUpdateProfile = vi.mocked(updateProfile);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // The dev-only diagnostic in `lib/firebase/auth.ts` writes to console.warn in
  // any non-production env, and vitest runs as `test`. Silenced so a deliberate
  // error path does not fill the reporter with expected noise.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/** Run an async call and return the AuthError it threw. */
async function catchAuthError(run: () => Promise<unknown>): Promise<AuthError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected the call to throw an AuthError, but it resolved');
}

/* ========================================================================== */
describe('project-configuration errors are named, not generic', () => {
  // Each of these is a misconfigured Firebase PROJECT, not a user mistake, and
  // each previously produced the default branch.
  const CONFIG_CODES = [
    'auth/configuration-not-found',
    'auth/invalid-api-key',
    'auth/api-key-not-valid',
    'auth/api-key-not-valid-http',
    'auth/api-key-not-valid-idp',
    'auth/app-not-authorized',
    'auth/project-not-found',
    'auth/auth-domain-not-authorized',
    'auth/app-not-initialized',
  ] as const;

  it.each(CONFIG_CODES)('%s maps to AUTH_CONFIG_INVALID', async (code) => {
    mockSignIn.mockRejectedValueOnce(firebaseError(code));

    const error = await catchAuthError(() => signIn({ email: 'a@b.test', password: 'password1' }));

    expect(error.code).toBe('AUTH_CONFIG_INVALID');
    // The regression itself: this is the exact sentence the bug produced.
    expect(error.message).not.toBe('Something went wrong. Try again.');
  });

  it('does not leak the internal code or any credential into the message', async () => {
    mockSignIn.mockRejectedValueOnce(firebaseError('auth/configuration-not-found'));

    const error = await catchAuthError(() => signIn({ email: 'victim@example.test', password: 'hunter2' }));

    expect(error.message).not.toContain('auth/');
    expect(error.message).not.toContain('victim@example.test');
    expect(error.message).not.toContain('hunter2');
  });

  it('still falls back to a generic message for a genuinely unknown code', async () => {
    mockSignIn.mockRejectedValueOnce(firebaseError('auth/some-future-code'));

    const error = await catchAuthError(() => signIn({ email: 'a@b.test', password: 'password1' }));

    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toBe('Something went wrong. Try again.');
  });

  it('keeps AUTH_OPERATION_NOT_ALLOWED distinct — a disabled provider is a different fix', async () => {
    mockSignIn.mockRejectedValueOnce(firebaseError('auth/operation-not-allowed'));

    const error = await catchAuthError(() => signIn({ email: 'a@b.test', password: 'password1' }));

    expect(error.code).toBe('AUTH_OPERATION_NOT_ALLOWED');
    expect(error.code).not.toBe('AUTH_CONFIG_INVALID');
  });
});

/* ========================================================================== */
describe('Google popup outcomes', () => {
  it('a cancelled chooser resolves to null rather than throwing', async () => {
    // Deliberately NOT an error. `signInWithGoogle` returns `null` so the form
    // stays untouched — no red banner and no announced error for something the
    // person chose to do. This pins that contract, because routing it through
    // the error mapper instead would be a regression: it would shout at someone
    // who simply changed their mind.
    mockPopup.mockRejectedValueOnce(firebaseError('auth/popup-closed-by-user'));

    await expect(signInWithGoogle()).resolves.toBeNull();
  });

  it('a superseded popup request is likewise not surfaced as a failure', async () => {
    mockPopup.mockRejectedValueOnce(firebaseError('auth/cancelled-popup-request'));

    const error = await catchAuthError(() => signInWithGoogle());
    expect(error.message).toMatch(/cancelled/i);
  });

  it('a blocked popup names pop-ups as the cause', async () => {
    mockPopup.mockRejectedValueOnce(firebaseError('auth/popup-blocked'));

    const error = await catchAuthError(() => signInWithGoogle());

    expect(error.message).toMatch(/pop-?ups?/i);
  });

  it('an address that already has a password account points at sign-in', async () => {
    mockPopup.mockRejectedValueOnce(firebaseError('auth/account-exists-with-different-credential'));

    const error = await catchAuthError(() => signInWithGoogle());

    expect(error.code).toBe('AUTH_EMAIL_ALREADY_EXISTS');
  });
});

/* ========================================================================== */
describe('partial sign-up: the account exists once createUser resolves', () => {
  const fakeUser = { uid: 'uid-123', providerData: [] } as never;

  it('reports creation success when only the profile write fails', async () => {
    mockCreate.mockResolvedValueOnce({ user: fakeUser } as never);
    mockUpdateProfile.mockRejectedValueOnce(firebaseError('auth/network-request-failed'));

    const error = await catchAuthError(() =>
      signUp({ email: 'new@example.test', password: 'password1', displayName: 'New Person' }),
    );

    // The bug: this used to be a single try, so this reported "We could not
    // create your account" for an account that had been created — and the
    // person's only retry then hit `auth/email-already-in-use`.
    expect(error.message).not.toMatch(/could not create your account/i);
    expect(error.message).toMatch(/account was created/i);
  });

  it('still maps a genuine creation failure as a creation failure', async () => {
    // The guard on the fix above: a real creation failure must NOT claim the
    // account exists, which would send the person to sign in for an account
    // that was never made.
    mockCreate.mockRejectedValueOnce(firebaseError('auth/email-already-in-use'));

    const error = await catchAuthError(() =>
      signUp({ email: 'taken@example.test', password: 'password1', displayName: 'Taken' }),
    );

    expect(error.code).toBe('AUTH_EMAIL_ALREADY_EXISTS');
    expect(error.message).not.toMatch(/account was created/i);
    // And the profile write must not have been attempted.
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it('does not call updateProfile when createUser fails', async () => {
    mockCreate.mockRejectedValueOnce(firebaseError('auth/invalid-email'));

    await catchAuthError(() =>
      signUp({ email: 'not-an-email', password: 'password1', displayName: 'X' }),
    );

    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it('resolves normally when both steps succeed', async () => {
    mockCreate.mockResolvedValueOnce({ user: fakeUser } as never);
    mockUpdateProfile.mockResolvedValueOnce(undefined as never);

    await expect(
      signUp({ email: 'ok@example.test', password: 'password1', displayName: 'Ok Person' }),
    ).resolves.toMatchObject({ provider: 'password' });
  });
});

/* ========================================================================== */
describe('development diagnostic', () => {
  it('logs the code, and never the password or the email', async () => {
    mockSignIn.mockRejectedValueOnce(firebaseError('auth/configuration-not-found'));

    await catchAuthError(() => signIn({ email: 'person@example.test', password: 'sup3rs3cret' }));

    const logged = warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).toContain('auth/configuration-not-found');
    expect(logged).not.toContain('sup3rs3cret');
    expect(logged).not.toContain('person@example.test');
  });
});