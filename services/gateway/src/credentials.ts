import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import https from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';

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

// The gateway can read/patch this one Secret, not arbitrary cluster Secrets.
export class KubernetesCredentials implements CredentialStore {
  path: string;
  constructor(namespace: string, name: string) {
    if (![namespace, name].every((part) => /^[a-z0-9-]+$/.test(part)))
      throw new Error('Invalid Secret location');
    this.path = `/api/v1/namespaces/${namespace}/secrets/${name}`;
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
    return data?.[id]
      ? validateCredential(
          JSON.parse(Buffer.from(data[id], 'base64').toString('utf8')),
        )
      : undefined;
  }
  async set(id: string, value: Credential | null): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('Invalid credential ID');
    await this.request('PATCH', {
      data: {
        [id]: value
          ? Buffer.from(JSON.stringify(validateCredential(value))).toString(
              'base64',
            )
          : null,
      },
    });
  }
}

export class FileCredentials implements CredentialStore {
  path: string;
  constructor(path = '.data/upstream-credentials.json') {
    this.path = path;
    mkdirSync('.data', { recursive: true, mode: 0o700 });
  }
  async get(id: string): Promise<Credential | undefined> {
    return existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))[id]
      : undefined;
  }
  async set(id: string, value: Credential | null): Promise<void> {
    const data = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : {};
    if (value) data[id] = validateCredential(value);
    else delete data[id];
    writeFileSync(this.path, JSON.stringify(data), { mode: 0o600 });
  }
}
