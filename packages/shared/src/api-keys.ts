import { createHmac, randomBytes } from 'node:crypto';

export function generateApiKey(): string {
  return `storelink_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string, pepper: Uint8Array): string {
  if (pepper.byteLength < 32) {
    throw new Error('API_KEY_PEPPER must contain at least 32 random bytes');
  }
  return createHmac('sha256', pepper).update(key, 'utf8').digest('hex');
}

export type Identity = {
  userId: string;
  teamId: string;
  keyId: string;
  sessionId?: string;
  role: 'admin' | 'member';
};
