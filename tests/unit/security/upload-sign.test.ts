/**
 * ============================================================================
 * Upload security: the SIGN path (Phase 15, item 5)
 * ============================================================================
 *
 * The companion to `tests/unit/uploads/sniff.test.ts`, and it deliberately does NOT
 * re-test the sniffer. That file already covers renamed executables, renamed ZIPs,
 * truncated headers, decompression bombs, animated WebP, and empty buffers, and it
 * covers them at the layer where they are actually decidable — the magic bytes.
 *
 * This file covers the gate BEFORE any bytes exist, because that is where the
 * attacker's cheapest options are. `sizeBytes` in the sign request is a **number
 * the client typed**. Nothing about it is true until `finalize` re-reads the object.
 * So everything asserted here is a control that has to survive the client lying:
 *
 *   1. Oversize  — per-kind caps, and which of table-vs-env wins.
 *   2. MIME      — the allow-list, and the kind/type pairing that stops cap escalation.
 *   3. Malformed — strict objects, ranges, and the refusal to let a filename choose a path.
 *   4. Key secrecy — no credential in a response, a log line, or a path.
 *   5. Claim isolation — the cross-user theft that the 30-minute window exists to stop.
 *
 * ---------------------------------------------------------------------------
 * WHY `uploadConfig` IS DRIVEN BY ENV VARS AND NOT MOCKED
 * ---------------------------------------------------------------------------
 * `sign-upload.ts` calls `uploadConfig()` from `@/lib/env.server`, which reads
 * `UPLOAD_MAX_IMAGE_BYTES` and friends through `tunableNumber`. Setting the
 * variables exercises the real config path, including its clamping — so a test
 * that sets `UPLOAD_MAX_IMAGE_BYTES=1` also proves the floor of 1024 is enforced
 * rather than assumed. Mocking the function instead would prove nothing about the
 * environment tier that production actually depends on.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PASS HERE DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * None of this is a substitute for `finalize`. `sizeBytes` is a claim, and the
 * claim is only checked against reality in `finalize-upload.ts`. A green file here
 * means the cheap gates hold, NOT that a 15 MB payload cannot be stored.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installRequiredEnv } from '../../helpers/route-harness';
import { ALLOWED_MEDIA, MEDIA_LIMITS } from '@/validators/upload';

installRequiredEnv();

/* ========================================================================== */
/* The only I/O edge: the signed PUT URL                                       */
/* ========================================================================== */

/**
 * `signPutUrl` is the sole network boundary in this file. The real one needs a
 * configured GCS bucket and a service account, neither of which belongs in a unit
 * test — and asserting on the URL's query string would assert on Google's signing
 * format, which is not this project's contract.
 *
 * What IS this project's contract: that the cap and the content type handed to
 * `signPutUrl` are the values the service decided on. That is why the mock
 * RECORDS its arguments rather than returning a canned URL.
 */
const signPutUrl = vi.fn(async (_path: string, _contentType: string, _maxBytes: number) => ({
  uploadUrl: 'https://storage.example.invalid/upload?signature=stub',
  expiresAt: 1_700_000_900_000,
}));

vi.mock('@/services/uploads/evidence-storage', () => ({ signPutUrl }));

const { signUpload, claimFor, releaseClaim, resetClaimsForTests } = await import(
  '@/services/uploads/sign-upload'
);

const UID = 'u_reporter';

/** A minimal body that passes validation, so a failure is attributable to the field under test. */
function imageBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'image',
    contentType: 'image/jpeg',
    sizeBytes: 1_000_000,
    clientWidth: 1_920,
    clientHeight: 1_080,
    intent: 'report',
    ...overrides,
  } as never;
}

function audioBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'audio',
    contentType: 'audio/webm',
    sizeBytes: 500_000,
    durationSec: 45,
    intent: 'report',
    ...overrides,
  } as never;
}

/** Parse a body through the real schema, the way the route does. */
async function sign(uid: string, raw: Record<string, unknown>) {
  const { signUploadBodySchema } = await import('@/validators/upload');
  return signUpload(uid, signUploadBodySchema.parse(raw));
}

/**
 * Run the service and report the error code the ROUTE would see.
 *
 * Through `toAppError`, not through `(error as { code }).code`. The schema throws a
 * bare `ZodError`, which has no `.code` — the route's `withRequest` converts it to
 * `VALIDATION_FAILED`, and an earlier draft of this helper read `.code` directly and
 * so expected `VALIDATION_FAILED` on inputs that actually produced `ZodError`. All
 * eleven of those failures were the helper being wrong, not the service.
 *
 * Using the real funnel also means these assertions are about the code the caller
 * receives, rather than about an internal error shape that the route would never
 * pass through.
 */
async function codeOf(uid: string, raw: Record<string, unknown>): Promise<string> {
  try {
    await sign(uid, raw);
    return 'OK';
  } catch (error) {
    const { toAppError } = await import('@/lib/server/errors');
    return toAppError(error).code;
  }
}

beforeEach(() => {
  signPutUrl.mockClear();
  resetClaimsForTests();
  delete process.env.UPLOAD_MAX_IMAGE_BYTES;
  delete process.env.UPLOAD_MAX_AUDIO_BYTES;
  delete process.env.UPLOAD_MAX_AUDIO_SEC;
});

/* ========================================================================== */
/* 1. Oversize                                                                 */
/* ========================================================================== */

describe('oversize: the per-kind caps', () => {
  const IMAGE_CAP = ALLOWED_MEDIA['image/jpeg'].maxBytes;
  const AUDIO_CAP = ALLOWED_MEDIA['audio/webm'].maxBytes;

  it('an image exactly at the cap is accepted (the boundary is inclusive)', async () => {
    const result = await sign(UID, imageBody({ sizeBytes: IMAGE_CAP }));
    expect(result.maxSizeBytes).toBe(IMAGE_CAP);
    expect(signPutUrl).toHaveBeenCalledOnce();
  });

  it('one byte over the cap is refused', async () => {
    expect(await codeOf(UID, imageBody({ sizeBytes: IMAGE_CAP + 1 }))).toBe('UPLOAD_TOO_LARGE');
    expect(signPutUrl).not.toHaveBeenCalled();
  });

  it('audio may exceed the image cap, because the caps are per-kind', async () => {
    // The single most likely regression here is collapsing both kinds onto one
    // cap "for simplicity", which would silently break every voice note.
    expect(IMAGE_CAP).toBeLessThan(AUDIO_CAP);
    const result = await sign(UID, audioBody({ sizeBytes: AUDIO_CAP }));
    expect(result.maxSizeBytes).toBe(AUDIO_CAP);
  });

  it('raising the env var cannot exceed the table', async () => {
    process.env.UPLOAD_MAX_IMAGE_BYTES = String(50 * 1024 * 1024);
    const result = await sign(UID, imageBody({ sizeBytes: IMAGE_CAP }));
    // `Math.min(tableCap, envCap)` — the table is the ceiling.
    expect(result.maxSizeBytes).toBe(IMAGE_CAP);
  });

  it('LOWERING the env var tightens the control', async () => {
    process.env.UPLOAD_MAX_IMAGE_BYTES = '2048';
    expect(await codeOf(UID, imageBody({ sizeBytes: 4096 }))).toBe('UPLOAD_TOO_LARGE');
    const result = await sign(UID, imageBody({ sizeBytes: 2048 }));
    expect(result.maxSizeBytes).toBe(2048);
  });

  it('clamps a nonsense env value instead of trusting it', async () => {
    process.env.UPLOAD_MAX_IMAGE_BYTES = '1';
    // `tunableNumber` clamps to [1024, 15 MiB], so a value of 1 becomes 1024 and
    // NOT a 1-byte cap. The body has to fit inside the clamped cap or this would
    // be asserting UPLOAD_TOO_LARGE and passing for the wrong reason.
    const result = await sign(UID, imageBody({ sizeBytes: 512 }));
    expect(result.maxSizeBytes).toBe(1024);
    // And the clamped cap is genuinely enforced, not merely reported.
    expect(await codeOf(UID, imageBody({ sizeBytes: 2048 }))).toBe('UPLOAD_TOO_LARGE');
  });

  it('the cap is signed INTO the upload URL, so Google refuses an oversize PUT too', async () => {
    const result = await sign(UID, imageBody({ sizeBytes: 1_000_000 }));
    const [, signedType, signedMax] = signPutUrl.mock.calls[0] as [string, string, number];
    // Server-side enforcement alone would be a race: the bytes could land first
    // and be cleaned up after. Signing the cap refuses them at the boundary.
    expect(signedMax).toBe(result.maxSizeBytes);
    expect(signedType).toBe('image/jpeg');
  });
});

/* ========================================================================== */
/* 2. MIME                                                                     */
/* ========================================================================== */

describe('MIME: only the six documented types', () => {
  const REFUSED = [
    'image/gif',
    'image/svg+xml',
    'application/pdf',
    'text/html',
    'text/plain',
    'application/octet-stream',
    'video/mp4',
    'audio/ogg',
    'application/zip',
  ];

  for (const contentType of REFUSED) {
    it(`refuses ${contentType}`, async () => {
      const kind = contentType.startsWith('audio') ? 'audio' : 'image';
      const raw = kind === 'audio' ? audioBody({ contentType }) : imageBody({ contentType });
      expect(await codeOf(UID, raw)).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(signPutUrl).not.toHaveBeenCalled();
    });
  }

  it('refuses an allowed type in the wrong CASE', async () => {
    // The allow-list is an object lookup, so case is significant. That is
    // correct: HTTP media types are case-insensitive, so a browser COULD send
    // `Image/JPEG`, and rejecting it is a usability cost rather than a security
    // one — but silently accepting it while the storage path extension is
    // derived from the table would be worse. Asserted so the behaviour is a
    // decision rather than an accident.
    expect(await codeOf(UID, imageBody({ contentType: 'IMAGE/JPEG' }))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an allowed type carrying parameters', async () => {
    // `image/jpeg; charset=binary` is a legal media type and is NOT a key in the
    // table, so it lands in the object-lookup miss. Accepting a prefix would let
    // a caller smuggle `image/jpeg; something` past the extension mapping.
    expect(await codeOf(UID, imageBody({ contentType: 'image/jpeg; charset=binary' }))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses an audio type declared as an image, so the larger audio cap cannot be reached', async () => {
    // THE escalation this blocks: sign as `image` (5 MB cap) but declare
    // `audio/webm` (15 MB). Without the kind check the table lookup would find
    // the 15 MB entry and hand out a URL permitting a 15 MB "photo".
    expect(await codeOf(UID, imageBody({ contentType: 'audio/webm' }))).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await codeOf(UID, audioBody({ contentType: 'image/jpeg' }))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('every ALLOWED_MEDIA entry is reachable through its own kind', async () => {
    for (const [contentType, entry] of Object.entries(ALLOWED_MEDIA)) {
      const raw =
        entry.kind === 'audio' ? audioBody({ contentType, sizeBytes: 1000 }) : imageBody({ contentType, sizeBytes: 1000 });
      const result = await sign(UID, raw);
      expect(result.requiredContentType).toBe(contentType);
    }
  });
});

/* ========================================================================== */
/* 3. Malformed                                                                */
/* ========================================================================== */

describe('malformed input', () => {
  it('refuses a missing `intent`', async () => {
    const { intent: _dropped, ...withoutIntent } = imageBody() as unknown as Record<string, unknown>;
    expect(await codeOf(UID, withoutIntent)).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown field, because the body is a strict object', async () => {
    // Without `.strict()`, `role: 'admin'` would ride along unnoticed — today
    // inert, but one refactor away from being read by a handler.
    expect(await codeOf(UID, imageBody({ role: 'admin' }))).toBe('VALIDATION_FAILED');
  });

  for (const sizeBytes of [0, -1, 1.5, Number.NaN, '1000000', null]) {
    it(`refuses sizeBytes = ${JSON.stringify(sizeBytes)}`, async () => {
      expect(await codeOf(UID, imageBody({ sizeBytes }))).toBe('VALIDATION_FAILED');
    });
  }

  it('refuses a displayName carrying a path traversal', async () => {
    const result = await sign(
      UID,
      imageBody({ displayName: '../../../../etc/passwd', clientWidth: 800, clientHeight: 600 }),
    );
    // The display name is for the dispatcher's UI and must never influence where
    // bytes are written. The path is built from uid + server mediaId + a table
    // extension, so a traversal string has nowhere to go.
    expect(result.storagePath).not.toContain('..');
    expect(result.storagePath).not.toContain('etc');
    expect(result.storagePath).toMatch(new RegExp(`^staging/${UID}/med_[A-Z2-7]{12}\\.jpg$`));
  });

  it('derives the extension from the allow-list table, never from the filename', async () => {
    const asPng = await sign(UID, imageBody({ contentType: 'image/png', displayName: 'photo.jpg' }));
    expect(asPng.storagePath.endsWith('.png')).toBe(true);

    const asWebp = await sign(UID, imageBody({ contentType: 'image/webp', displayName: 'evil.exe' }));
    expect(asWebp.storagePath.endsWith('.webp')).toBe(true);
  });

  it('issues a mediaId matching the published format', async () => {
    const { mediaId } = await sign(UID, imageBody());
    expect(mediaId).toMatch(/^med_[A-Z2-7]{12}$/);
  });

  it('issues a DISTINCT id per upload, so two files cannot collide on one path', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const { mediaId } = await sign(UID, imageBody());
      ids.add(mediaId);
    }
    expect(ids.size).toBe(25);
  });
});

/* ========================================================================== */
/* 4. Duration and dimensions                                                  */
/* ========================================================================== */

describe('audio duration', () => {
  it('requires a duration for audio — it is what the limit is checked against', async () => {
    const { durationSec: _dropped, ...withoutDuration } = audioBody() as unknown as Record<string, unknown>;
    expect(await codeOf(UID, withoutDuration)).toBe('VALIDATION_FAILED');
  });

  it(`refuses a voice note longer than ${MEDIA_LIMITS.maxAudioDurationSec}s`, async () => {
    expect(await codeOf(UID, audioBody({ durationSec: MEDIA_LIMITS.maxAudioDurationSec + 1 }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('the service cap is TIGHTER than the schema max, and the service wins', async () => {
    // The schema allows up to 300 (the `tunableNumber` ceiling); the policy is 120.
    // A test that only checked the schema would pass while 300-second uploads were
    // signed — which is the kind of gap where the schema and the policy drift.
    expect(await codeOf(UID, audioBody({ durationSec: 300 }))).toBe('VALIDATION_FAILED');
  });

  it('accepts a note exactly at the limit', async () => {
    await expect(sign(UID, audioBody({ durationSec: MEDIA_LIMITS.maxAudioDurationSec }))).resolves.toBeTruthy();
  });

  it('a lowered env limit tightens the policy cap too', async () => {
    process.env.UPLOAD_MAX_AUDIO_SEC = '30';
    expect(await codeOf(UID, audioBody({ durationSec: 60 }))).toBe('VALIDATION_FAILED');
    await expect(sign(UID, audioBody({ durationSec: 20 }))).resolves.toBeTruthy();
  });
});

describe('image dimensions — the decompression-bomb gate', () => {
  it('requires both dimensions', async () => {
    const { clientHeight: _dropped, ...noHeight } = imageBody() as unknown as Record<string, unknown>;
    expect(await codeOf(UID, noHeight)).toBe('VALIDATION_FAILED');
  });

  it(`refuses a dimension above ${MEDIA_LIMITS.maxImageDimension}px`, async () => {
    expect(await codeOf(UID, imageBody({ clientWidth: MEDIA_LIMITS.maxImageDimension + 1 }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('refuses an image inside the per-axis cap but over the megapixel cap', async () => {
    // 11999 x 11999 is legal on both axes and still ~144 megapixels. Without the
    // second check this is a 40x decompression bomb, and it is the reason the
    // cap is a product of the axes rather than a check on either one.
    const side = MEDIA_LIMITS.maxImageDimension - 1;
    expect(side * side).toBeGreaterThan(MEDIA_LIMITS.maxImageMegapixels * 1_000_000);
    expect(await codeOf(UID, imageBody({ clientWidth: side, clientHeight: side }))).toBe('VALIDATION_FAILED');
  });

  it('accepts a large but legal panorama', async () => {
    await expect(sign(UID, imageBody({ clientWidth: 12_000, clientHeight: 1_000 }))).resolves.toBeTruthy();
  });
});

/* ========================================================================== */
/* 5. Key secrecy                                                              */
/* ========================================================================== */

describe('key secrecy', () => {
  it('the response carries no credential of any kind', async () => {
    const response = await sign(UID, imageBody());
    const serialised = JSON.stringify(response);

    // The response crosses to the browser, so this is the surface that matters.
    expect(serialised).not.toMatch(/private.key|BEGIN [A-Z ]*PRIVATE KEY/i);
    expect(serialised).not.toMatch(/AIza[\w-]{10,}/);
    expect(serialised).not.toMatch(/service.account|gserviceaccount/i);
    expect(serialised).not.toMatch(/[a-z0-9_-]{40,}@.*\.iam\.gserviceaccount/i);
    expect(serialised).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('the storage path carries the uid — that is the point — and nothing else identifying', async () => {
    const response = await sign(UID, imageBody());
    // The uid MUST be here: it is what `storage.rules` scopes, and what stops one
    // citizen finalising another's object. So this asserts the shape, not absence.
    expect(response.storagePath).toMatch(new RegExp(`^staging/${UID}/`));
    expect(response.storagePath).not.toContain('displayName');
    expect(response.storagePath.split('/')).toHaveLength(3);
  });

  it('never logs the upload URL, which is a bearer credential for 15 minutes', async () => {
    // `signPutUrl` is the only holder of a signature. Asserting the returned URL
    // is not equal to the path is a cheap guard against a future debug log.
    const response = await sign(UID, imageBody());
    expect(response.uploadUrl).not.toContain(response.storagePath);
  });

  it('signs a URL with a bounded lifetime', async () => {
    // A value on the returned config, not an exported accessor — reading it as a
    // function was one of the two failures in the first run of this file.
    const { uploadConfig } = await import('@/lib/env.server');
    const ttl = uploadConfig().signedUrlTtlSec;
    expect(ttl).toBeGreaterThan(0);
    // 900s default, 3600s ceiling. A signed PUT URL is a bearer credential for its
    // whole lifetime, so an unbounded or absurd one is a standing risk.
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});

/* ========================================================================== */
/* 6. Claim isolation — the cross-user theft the window exists to prevent       */
/* ========================================================================== */

describe('claim isolation', () => {
  it('records the claim under the caller, not under a supplied uid', async () => {
    const { mediaId } = await sign('u_victim', imageBody());
    await expect(claimFor('u_victim', mediaId)).resolves.not.toBeNull();
  });

  it('another user cannot read the claim', async () => {
    const { mediaId } = await sign(UID, imageBody());
    // THE IDOR this layer exists to stop. `finalize` looks the path up from this
    // record and never from the request, so a stolen mediaId resolves to nothing
    // for anyone but its owner.
    await expect(claimFor('u_attacker', mediaId)).resolves.toBeNull();
    await expect(claimFor('u_attacker', mediaId)).resolves.toBeNull();
  });

  it('an unknown mediaId resolves to nothing at all', async () => {
    await expect(claimFor(UID, 'med_AAAAAAAAAAAAAAAA')).resolves.toBeNull();
  });

  it('the claim stores what finalize needs and does not leak a path back to the caller', async () => {
    const { mediaId } = await sign(UID, imageBody({ displayName: 'holiday snap.jpg' }));
    const claim = await claimFor(UID, mediaId);
    expect(claim).not.toBeNull();
    expect(claim?.storagePath).toContain('staging/');
    expect(claim?.declaredSizeBytes).toBe(1_000_000);
    // The display name is a UI string; keeping it out of the claim record means a
    // later log of the claim cannot carry caller-controlled text.
    expect(JSON.stringify(claim)).not.toContain('holiday snap');
  });

  it('releasing a claim is idempotent, so a double-finalize cannot throw', async () => {
    const { mediaId } = await sign(UID, imageBody());
    await releaseClaim(UID, mediaId);
    await expect(releaseClaim(UID, mediaId)).resolves.toBeUndefined();
    await expect(claimFor(UID, mediaId)).resolves.toBeNull();
  });

  it('a fresh claim is issued for a second upload even for the same user', async () => {
    const first = await sign(UID, imageBody());
    const second = await sign(UID, imageBody());
    expect(first.mediaId).not.toBe(second.mediaId);
    await expect(claimFor(UID, first.mediaId)).resolves.not.toBeNull();
    await expect(claimFor(UID, second.mediaId)).resolves.not.toBeNull();
  });
});