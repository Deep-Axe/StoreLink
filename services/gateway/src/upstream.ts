import { Agent } from 'undici';
import type { LookupFunction } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolClient } from './gateway.ts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { validateCredential } from './credentials.ts';
import type { Credential } from './credentials.ts';

export function upstreamClient(
  url: URL,
  serviceToken: string | Credential,
  fetcher?: typeof fetch,
  options: { connectTimeoutMs?: number; lookup?: LookupFunction } = {},
): ToolClient & { close: () => Promise<void> } {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Invalid MCP upstream URL');
  const dispatcher = fetcher
    ? undefined
    : new Agent({
        connect: {
          timeout: options.connectTimeoutMs ?? 2000,
          ...(options.lookup ? { lookup: options.lookup } : {}),
        },
        connections: 2,
        pipelining: 1,
      });
  const upstreamFetch: typeof fetch =
    fetcher ??
    ((input, init) => {
      const settings = { ...init, dispatcher };
      return fetch(input, settings);
    });
  let connection: Promise<Client> | undefined;
  const credential =
    typeof serviceToken === 'string'
      ? serviceToken
        ? { header: 'authorization', value: `Bearer ${serviceToken}` }
        : undefined
      : validateCredential(serviceToken);
  async function connected(): Promise<Client> {
    if (!connection) {
      const client = new Client({ name: 'urumi-gateway', version: '0.1.0' });
      connection = client
        .connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: {
              headers: credential
                ? { [credential.header]: credential.value }
                : {},
              redirect: 'error',
            },
            fetch: upstreamFetch,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          }),
          { timeout: 3000 },
        )
        .then(() => client)
        .catch(async () => {
          connection = undefined;
          await client.close();
          throw new Error('MCP upstream initialization failed');
        });
    }
    return connection;
  }
  return {
    async listTools(params, options) {
      return (await connected()).listTools(params, options);
    },
    async callTool(params, _schema, options) {
      return (await (
        await connected()
      ).callTool(params, undefined, options)) as CallToolResult;
    },
    async close() {
      if (connection) {
        const client = await connection.catch(() => undefined);
        await client?.close();
      }
      connection = undefined;
      await dispatcher?.destroy();
    },
  };
}
