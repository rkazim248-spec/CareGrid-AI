import { describe, expect, it } from 'vitest';

import { partitionUploads } from '@/features/reporting/upload-manager';
import { incidentMediaListSchema } from '@/validators/incident';
import type { PendingUpload, UploadStatus } from '@/types/media';

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

/**
 * `med_` ids are base32 over `A-Z2-7`, so `0`, `1`, `8` and `9` are not legal
 * characters in them. Fixtures below respect that deliberately: an invalid id fails
 * the regex before the count rules are ever reached, so a "too many files" test
 * written with sloppy ids would be asserting on the wrong error.
 */
const STAGING_JPG = 'staging/uid_abc123/med_ABCDEFGH2345.jpg';
const STAGING_WEBM = 'staging/uid_abc123/med_ZYXWVUTS2345.webm';

/**
 * `count` distinct, legal, deterministic ids for the cap tests.
 *
 * `med_` plus eleven alphabet characters plus one varying character. The varying
 * digit is offset by 2 because `0`, `1`, `8` and `9` are outside `[A-Z2-7]`, and an
 * illegal id is rejected by the regex before the count rules run — which would make
 * a cap test silently assert on the wrong error.
 */
function stagingPaths(count: number, ext = 'jpg'): string[] {
  return Array.from({ length: count }, (_, index) =>
    `staging/uid_abc123/med_ABCDEFGH234${index + 2}.${ext}`,
  );
}

function upload(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    localId: 'up_1',
    status: 'uploaded',
    progress: 100,
    fileName: 'crash.jpg',
    sizeBytes: 240_000,
    declaredMimeType: 'image/jpeg',
    kind: 'image',
    storagePath: STAGING_JPG,
    mediaId: 'med_ABCDEFGH2345',
    ...overrides,
  };
}

function atStatus(status: UploadStatus, overrides: Partial<PendingUpload> = {}): PendingUpload {
  return upload({ status, progress: 40, mediaId: undefined, ...overrides });
}

/* ========================================================================== */

describe('only a fully uploaded item with a staging path is attachable', () => {
  it('attaches a completed upload', () => {
    const summary = partitionUploads([upload()]);

    expect(summary.attachable).toEqual([{ storagePath: STAGING_JPG, displayName: 'crash.jpg' }]);
    expect(summary.inFlight).toEqual([]);
    expect(summary.failed).toEqual([]);
  });

  it('sends the file NAME as the display name, not the storage path', () => {
    // The display name is what a responder reads in an evidence list. Sending the
    // path would leak a uid into the UI and read as machine noise.
    const summary = partitionUploads([upload({ fileName: 'my crash photo.jpg' })]);

    expect(summary.attachable[0]?.displayName).toBe('my crash photo.jpg');
  });

  it('an empty input produces an empty summary, not undefined', () => {
    expect(partitionUploads([])).toEqual({ attachable: [], inFlight: [], failed: [] });
  });
});

/* ========================================================================== */

describe('BOTH conditions are required, and neither alone is enough', () => {
  it('a signed-but-still-uploading item is in-flight, not attachable', () => {
    // It HAS a `storagePath` — the sign step set it — and it is not `uploaded`.
    // Attaching it would point the server at bytes that are not there yet.
    const item = atStatus('uploading', { storagePath: STAGING_JPG });

    const summary = partitionUploads([item]);

    expect(summary.attachable).toEqual([]);
    expect(summary.inFlight).toHaveLength(1);
  });

  it('a finalized-but-pathless item is in-flight, not attachable', () => {
    // Defensive: this state is unreachable through `startUpload`, which is the point.
    // If it ever became reachable the partition must not invent an attachable item.
    const item = upload({ storagePath: undefined });

    const summary = partitionUploads([item]);

    expect(summary.attachable).toEqual([]);
    expect(summary.inFlight).toHaveLength(1);
  });

  it.each(['validating', 'ready', 'signing', 'uploading', 'finalizing'] as const)(
    'a %s item is never attachable, even with a staging path',
    (status) => {
      const summary = partitionUploads([atStatus(status, { storagePath: STAGING_JPG })]);

      expect(summary.attachable).toEqual([]);
      expect(summary.inFlight).toHaveLength(1);
      expect(summary.failed).toEqual([]);
    },
  );
});

/* ========================================================================== */

describe('a failed item is reported, never quietly dropped', () => {
  it('lands in `failed`, not `inFlight`', () => {
    // The distinction is what lets the form say "that photo did not upload" instead
    // of "wait for it to finish", which would be nonsense for a file that is never
    // going to finish.
    const item = upload({ status: 'failed', storagePath: undefined, error: 'Storage refused it.' });

    const summary = partitionUploads([item]);

    expect(summary.failed).toHaveLength(1);
    expect(summary.inFlight).toEqual([]);
    expect(summary.attachable).toEqual([]);
  });

  it('a failed item with a leftover path is still failed', () => {
    // The retry path can leave a path from an earlier sign. Status wins, so a failed
    // upload is never resurrected by a stale locator.
    const summary = partitionUploads([upload({ status: 'failed', storagePath: STAGING_JPG })]);

    expect(summary.attachable).toEqual([]);
    expect(summary.failed).toHaveLength(1);
  });
});

/* ========================================================================== */

describe('a mixed store is partitioned completely and without loss', () => {
  it('accounts for every item exactly once', () => {
    const items = [
      upload({ localId: 'a', storagePath: STAGING_JPG }),
      upload({ localId: 'b', status: 'failed', storagePath: undefined }),
      atStatus('uploading', { localId: 'c', storagePath: STAGING_WEBM }),
      atStatus('finalizing', { localId: 'd' }),
    ];

    const summary = partitionUploads(items);
    const accounted = summary.attachable.length + summary.inFlight.length + summary.failed.length;

    // The invariant that matters: an item can never vanish between the store and the
    // request. A silently missing item is a photo the citizen believes they sent.
    expect(accounted).toBe(items.length);
    expect(summary.attachable).toHaveLength(1);
    expect(summary.inFlight).toHaveLength(2);
    expect(summary.failed).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const items = [upload(), atStatus('uploading')];
    const snapshot = items.map((item) => item.localId);

    partitionUploads(items);

    expect(items.map((item) => item.localId)).toEqual(snapshot);
    expect(items).toHaveLength(2);
  });
});

/* ========================================================================== */

describe('everything this module produces is legal by construction', () => {
  it('the attach list passes the same schema the server validates with', () => {
    // If either side drifts, this fails rather than a citizen discovering it as a
    // 400 after the rest of the report has been written.
    const summary = partitionUploads([
      upload({ localId: 'a', storagePath: STAGING_JPG, fileName: 'crash.jpg' }),
      upload({
        localId: 'b',
        storagePath: STAGING_WEBM,
        fileName: 'note.webm',
        kind: 'audio',
      }),
    ]);

    const parsed = incidentMediaListSchema.safeParse(summary.attachable);

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('a path in a final incident location is refused by the schema', () => {
    // The client must never be able to claim an already-attached file. The server
    // re-checks this, and so does the schema.
    const parsed = incidentMediaListSchema.safeParse([
      {
        storagePath: 'incidents/inc_1/reports/rep_1/med_ABCDEFGH2345.jpg',
        displayName: 'x.jpg',
      },
    ]);

    expect(parsed.success).toBe(false);
  });

  it('a traversing path is refused by the schema', () => {
    const parsed = incidentMediaListSchema.safeParse([
      {
        storagePath: 'staging/uid_abc123/../../incidents/inc_1/med_ABCDEFGH2345.jpg',
        displayName: 'x.jpg',
      },
    ]);

    expect(parsed.success).toBe(false);
  });

  it('more media than a report allows fails with a message a person can read', () => {
    const parsed = incidentMediaListSchema.safeParse(
      stagingPaths(5).map((storagePath, index) => ({
        storagePath,
        displayName: `photo-${index}.jpg`,
      })),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/at most/i);
  });

  it('more than three photos is refused even inside the total cap', () => {
    // The per-kind rule and the total rule are different limits, and the per-kind one
    // is the one a citizen hits first with photos.
    const parsed = incidentMediaListSchema.safeParse(
      stagingPaths(4).map((storagePath, index) => ({
        storagePath,
        displayName: `photo-${index}.jpg`,
      })),
    );

    expect(parsed.success).toBe(false);
  });

  it('the TOTAL cap of 3 binds before the per-kind caps do', () => {
    // docs/15 §7.1 fixes "Max total media items: 3", so three photos already
    // exhaust the budget and a voice note cannot be added alongside them.
    //
    // This is asserted as the CURRENT behaviour rather than treated as obviously
    // right, because it is the kind of limit that looks like an oversight: the form
    // copy says "up to 3 photos" and "up to one clip" with no mention that they
    // compete. If the intent is 3 photos PLUS a clip, `MEDIA_LIMITS.maxTotalPerReport`
    // is the single line to change — and this test is what will point at it.
    const parsed = incidentMediaListSchema.safeParse([
      ...stagingPaths(3).map((storagePath, index) => ({
        storagePath,
        displayName: `photo-${index}.jpg`,
      })),
      ...stagingPaths(1, 'webm').map((storagePath) => ({
        storagePath,
        displayName: 'note.webm',
      })),
    ]);

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/at most 3 media items/i);
  });

  it('two photos and a clip fit inside the total cap', () => {
    const parsed = incidentMediaListSchema.safeParse([
      ...stagingPaths(2).map((storagePath, index) => ({
        storagePath,
        displayName: `photo-${index}.jpg`,
      })),
      ...stagingPaths(1, 'webm').map((storagePath) => ({
        storagePath,
        displayName: 'note.webm',
      })),
    ]);

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});