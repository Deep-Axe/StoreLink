import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

// Upstream credentials are stored as AES-256-GCM envelopes. The credential ID
// is authenticated data, so an entry cannot be moved to another server's slot.
type Envelope = { v: 1; iv: string; tag: string; data: string };

export function credentialKey(pepper: Uint8Array): Buffer {
  if (pepper.byteLength < 32)
    throw new Error('Credential key material must contain 32 random bytes');
  return Buffer.from(
    hkdfSync(
      'sha256',
      pepper,
      new Uint8Array(),
      'storelink-upstream-credential-v1',
      32,
    ),
  );
}

export function sealCredential(
  key: Buffer,
  id: string,
  plaintext: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id, 'utf8'));
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(envelope);
}

export function isSealed(stored: unknown): stored is Envelope {
  return (
    typeof stored === 'object' &&
    stored !== null &&
    (stored as { v?: unknown }).v === 1
  );
}

// Throws when the envelope was altered, moved to another ID or sealed with another key.
export function openCredential(
  key: Buffer,
  id: string,
  envelope: Envelope,
): string {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error('Invalid credential envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(id, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
