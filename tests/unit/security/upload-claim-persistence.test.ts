import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';

import { installRequiredEnv } from '../../helpers/route-harness';

const claimRecords = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('@/lib/server/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (collectionName: string) => ({
      doc: (uid: string) => ({
        collection: (subcollectionName: string) => ({
          doc: (mediaId: string) => {
            const key = `${collectionName}/${uid}/${subcollectionName}/${mediaId}`;
            return {
              create: async (value: Record<string, unknown>) => {
                if (claimRecords.has(key)) throw new Error('already exists');
                claimRecords.set(key, value);
              },
              get: async () => {
                const value = claimRecords.get(key);
                return { exists: value !== undefined, data: () => value };
              },
              delete: async () => {
                claimRecords.delete(key);
              },
            };
          },
        }),
      }),
    }),
  }),
}));

vi.mock('@/services/uploads/evidence-storage', () => ({
  signPutUrl: vi.fn(async () => ({
    uploadUrl: 'https://storage.example.invalid/upload',
    expiresAt: Date.now() + 900_000,
  })),
}));

installRequiredEnv();

const { claimFor, releaseClaim, signUpload } = await import('@/services/uploads/sign-upload');
const { signUploadBodySchema } = await import('@/validators/upload');

beforeEach(() => {
  claimRecords.clear();
  vi.stubEnv('NODE_ENV', 'production');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverless upload claim persistence', () => {
  it('writes a bounded claim below the authenticated user for later invocations', async () => {
    const signed = await signUpload(
      'u_reporter',
      signUploadBodySchema.parse({
        kind: 'image',
        contentType: 'image/jpeg',
        sizeBytes: 1_000_000,
        clientWidth: 1_920,
        clientHeight: 1_080,
        displayName: 'scene.jpg',
        intent: 'report',
      }),
    );

    const [key, record] = [...claimRecords.entries()][0] ?? [];
    expect(key).toBe(`users/u_reporter/uploadClaims/${signed.mediaId}`);
    expect(record?.storagePath).toBe(signed.storagePath);
    expect(record?.expiresAt).toBeInstanceOf(Timestamp);
    await expect(claimFor('u_reporter', signed.mediaId)).resolves.toMatchObject({
      uid: 'u_reporter',
      mediaId: signed.mediaId,
      storagePath: signed.storagePath,
    });
  });

  it('cannot resolve a claim through another user path and supports release', async () => {
    const signed = await signUpload(
      'u_reporter',
      signUploadBodySchema.parse({
        kind: 'audio',
        contentType: 'audio/webm',
        sizeBytes: 500_000,
        durationSec: 30,
        displayName: 'voice.webm',
        intent: 'report',
      }),
    );

    await expect(claimFor('u_attacker', signed.mediaId)).resolves.toBeNull();
    await releaseClaim('u_reporter', signed.mediaId);
    await expect(claimFor('u_reporter', signed.mediaId)).resolves.toBeNull();
  });
});
