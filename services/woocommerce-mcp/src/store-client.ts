import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function oauthAuthorization(
  method: string,
  url: URL,
  consumerKey: string,
  consumerSecret: string,
  nonce = randomBytes(16).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: timestamp,
  };
  const pairs = [...url.searchParams, ...Object.entries(oauth)]
    .filter(([name]) => name !== 'oauth_signature')
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    );
  const baseUri = `${url.origin}${url.pathname}`;
  const normalized = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  const base = `${method.toUpperCase()}&${encode(baseUri)}&${encode(normalized)}`;
  oauth.oauth_signature = createHmac('sha256', `${encode(consumerSecret)}&`)
    .update(base)
    .digest('base64');
  return `OAuth ${Object.entries(oauth)
    .map(([key, value]) => `${encode(key)}="${encode(value)}"`)
    .join(', ')}`;
}

export type StoreRequest = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
};
export type StoreResponse = {
  status: number;
  contentType: string;
  body: string;
};

export class StoreRequestError extends Error {
  uncertain: boolean;
  constructor(message: string, uncertain: boolean) {
    super(message);
    this.uncertain = uncertain;
  }
}

export function privateStoreSender(
  canonicalHostname: string,
  connectService: string,
  timeoutMs = 10000,
) {
  return async (input: StoreRequest): Promise<StoreResponse> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        input.url,
        {
          method: input.method,
          headers: input.headers,
          lookup(hostname, options, callback) {
            if (hostname !== canonicalHostname) {
              callback(new Error('Unexpected store hostname'), '', 4);
              return;
            }
            lookup(connectService, options, callback);
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 262144) {
              response.destroy(new Error('Store response too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () =>
            reject(new Error('Store response interrupted')),
          );
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 502,
              contentType: response.headers['content-type'] ?? '',
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.setTimeout(timeoutMs, () =>
        request.destroy(new Error('Store timeout')),
      );
      request.on('error', () => reject(new Error('Store connection failed')));
      if (input.body) request.write(input.body);
      request.end();
    });
}

export class WooStoreClient {
  origin: URL;
  consumerKey: string;
  consumerSecret: string;
  send: (input: StoreRequest) => Promise<StoreResponse>;

  constructor(options: {
    publicUrl: string;
    consumerKey: string;
    consumerSecret: string;
    connectService: string;
    send?: (input: StoreRequest) => Promise<StoreResponse>;
  }) {
    const origin = new URL(options.publicUrl);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.port ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      throw new Error(
        'Store public URL must be an HTTP(S) origin using a default port',
      );
    }
    origin.protocol = 'http:';
    this.origin = origin;
    this.consumerKey = options.consumerKey;
    this.consumerSecret = options.consumerSecret;
    if (!this.consumerKey || !this.consumerSecret || !options.connectService)
      throw new Error('Store credentials and private destination are required');
    this.send =
      options.send ??
      privateStoreSender(origin.hostname, options.connectService);
  }

  async request(
    method: 'GET' | 'POST' | 'PUT',
    endpoint: string,
    query: Record<string, string | number> = {},
    body?: unknown,
  ): Promise<unknown> {
    if (!/^(products|orders)(\/\d+)?$/.test(endpoint))
      throw new Error('Unsupported store endpoint');
    const url = new URL(`/wp-json/wc/v3/${endpoint}`, this.origin);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, String(value));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let response: StoreResponse;
    try {
      response = await this.send({
        url,
        method,
        body: payload,
        headers: {
          accept: 'application/json',
          authorization: oauthAuthorization(
            method,
            url,
            this.consumerKey,
            this.consumerSecret,
          ),
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      });
    } catch {
      throw new StoreRequestError(
        'Store connection failed; check the outcome before retrying a change',
        method !== 'GET',
      );
    }
    // Never follow redirects, echo response bodies, or propagate credential-bearing HTTP errors.
    if (response.status >= 300 && response.status < 400)
      throw new StoreRequestError(
        'Store redirected: check the canonical URL configuration',
        method !== 'GET',
      );
    if (response.status === 401 || response.status === 403)
      throw new StoreRequestError(
        'Store authentication or permissions rejected the request',
        false,
      );
    if (response.status < 200 || response.status >= 300)
      throw new StoreRequestError(
        `Store returned HTTP ${response.status}`,
        method !== 'GET' && response.status >= 500,
      );
    if (!/^application\/json\b/i.test(response.contentType))
      throw new StoreRequestError(
        'Store returned non-JSON content',
        method !== 'GET',
      );
    try {
      return JSON.parse(response.body);
    } catch {
      throw new StoreRequestError(
        'Store returned invalid JSON',
        method !== 'GET',
      );
    }
  }
}
