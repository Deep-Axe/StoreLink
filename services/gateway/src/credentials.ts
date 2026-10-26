import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import https from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';
import {
  credentialKey,
  isSealed,
  openCredential,
  sealCredential,
} from '../../../packages/shared/src/credential-cipher.ts';

export type Credential = { header: string; value: string };
export class CredentialInputError extends Error {}
export interface CredentialStore {
  get(id: string): Promise<Credential | undefined>;
  set(id: string, value: Credential | null): Promise<void>;
}

export function validateCredential(value: Credential): Credential {
  if (
    !/^[a-zA-Z0-9-]{1,64}$/.test(value.header) ||
    /^(host|cookie|set-cookie|connection|content-length|content-type|transfer-encoding|origin|forwarded|x-forwarded-.*)$/i.test(
      value.header,
    ) ||
    !value.value ||
    value.value.length > 4096 ||
    /[\r\n]/.test(value.value)
  )
    throw new CredentialInputError('Invalid credential header');
  return value;
}

function seal(key: Buffer, id: string, value: Credential): string {
  return sealCredential(key, id, JSON.stringify(validateCredential(value)));
}

// Plaintext entries from older releases are still readable; sealed ones fail closed.
function open(key: Buffer, id: string, stored: unknown): Credential {
  return validateCredential(
    isSealed(stored)
      ? JSON.parse(openCredential(key, id, stored))
      : (stored as Credential),
  );
}

export class SecretConflictError extends Error {}

// The gateway can read/patch this one Secret, not arbitrary cluster Secrets.
export class KubernetesCredentials implements CredentialStore {
  path: string;
  key: Buffer;
  constructor(namespace: string, name: string, pepper: Uint8Array) {
    if (![namespace, name].every((part) => /^[a-z0-9-]+$/.test(part)))
      throw new Error('Invalid Secret location');
    this.path = `/api/v1/namespaces/${namespace}/secrets/${name}`;
    this.key = credentialKey(pepper);
  }
  async request(
    method: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const directory = '/var/run/secrets/kubernetes.io/serviceaccount';
    const headers: OutgoingHttpHeaders = {
      authorization: `Bearer ${readFileSync(`${directory}/token`, 'utf8').trim()}`,
    };
    if (body) headers['content-type'] = 'application/merge-patch+json';
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: process.env.KUBERNETES_SERVICE_HOST,
          port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? 443),
          path: this.path,
          method,
          headers,
          ca: readFileSync(`${directory}/ca.crt`),
          timeout: 3000,
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1048576)
              request.destroy(new Error('Secret exceeds limit'));
          });
          response.on('end', () => {
            if (response.statusCode === 409) {
              reject(new SecretConflictError('Credential Secret changed'));
              return;
            }
            if (response.statusCode !== 200) {
              reject(new Error('Credential Secret is unavailable'));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('Invalid Secret response'));
            }
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Secret request timed out')),
      );
      request.on('error', () =>
        reject(new Error('Credential Secret is unavailable')),
      );
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async get(id: string): Promise<Credential | undefined> {
    const result = await this.request('GET');
    const data = result.data as Record<string, string> | undefined;
    return data?.[id] ? open(this.key, id, decode(data[id])) : undefined;
  }
  async set(id: string, value: Credential | null): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('Invalid credential ID');
    await this.request('PATCH', {
      data: { [id]: value ? encode(seal(this.key, id, value)) : null },
    });
  }
  // Seals plaintext entries left by older releases. The resourceVersion makes the
  // patch fail rather than overwrite a credential changed in the meantime.
  async sealLegacy(): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.request('GET');
      const metadata = result.metadata as {
        resourceVersion: string;
        annotations?: Record<string, string>;
      };
      const data = (result.data ?? {}) as Record<string, string>;
      const sealed: Record<string, string> = {};
      for (const [id, stored] of Object.entries(data)) {
        const value = decode(stored);
        if (!isSealed(value))
          sealed[id] = encode(seal(this.key, id, value as Credential));
      }
      // `kubectl apply` keeps a copy of the applied data in this annotation.
      const applied = metadata.annotations?.[lastApplied];
      const plaintextCopy =
        applied !== undefined &&
        Object.values(
          (JSON.parse(applied) as { data?: Record<string, string> }).data ?? {},
        ).some((stored) => !isSealed(decode(stored)));
      if (!Object.keys(sealed).length && !plaintextCopy) return 0;
      try {
        await this.request('PATCH', {
          metadata: {
            resourceVersion: metadata.resourceVersion,
            ...(plaintextCopy && { annotations: { [lastApplied]: null } }),
          },
          data: sealed,
        });
        return Object.keys(sealed).length;
      } catch (error) {
        if (!(error instanceof SecretConflictError) || attempt >= 2)
          throw error;
      }
    }
  }
}

const lastApplied = 'kubectl.kubernetes.io/last-applied-configuration';
const decode = (stored: string): unknown =>
  JSON.parse(Buffer.from(stored, 'base64').toString('utf8'));
const encode = (value: string) => Buffer.from(value).toString('base64');

export class FileCredentials implements CredentialStore {
  path: string;
  key: Buffer;
  constructor(pepper: Uint8Array, path = '.data/upstream-credentials.json') {
    this.path = path;
    this.key = credentialKey(pepper);
    mkdirSync('.data', { recursive: true, mode: 0o700 });
  }
  private read(): Record<string, unknown> {
    return existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : {};
  }
  async get(id: string): Promise<Credential | undefined> {
    const stored = this.read()[id];
    return stored ? open(this.key, id, stored) : undefined;
  }
  async set(id: string, value: Credential | null): Promise<void> {
    const data = this.read();
    if (value) data[id] = JSON.parse(seal(this.key, id, value));
    else delete data[id];
    writeFileSync(this.path, JSON.stringify(data), { mode: 0o600 });
  }
}
