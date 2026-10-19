import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpHttpHandler } from '../packages/shared/src/mcp-http.ts';
import { upstreamClient } from '../services/gateway/src/upstream.ts';

test('an unanswered connection has its own short deadline', async (t) => {
  let lookups = 0;
  const client = upstreamClient(
    new URL('http://blackhole.test/mcp'),
    '',
    undefined,
    {
      connectTimeoutMs: 40,
      lookup() {
        lookups++; /* Simulate an unanswered DNS/connect attempt. */
      },
    },
  );
  t.after(() => client.close());
  const started = performance.now();
  await assert.rejects(() => client.listTools());
  assert.ok(lookups > 0);
  assert.ok(
    performance.now() - started >= 20,
    'The test must reach a real connection timeout',
  );
  assert.ok(
    performance.now() - started < 2000,
    'connect timeout must not wait for the 3 s discovery or 15 s call budget',
  );
});
test('connect timeout does not shorten a healthy tool execution', async (t) => {
  let handle: (request: Request) => Promise<Response>;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(name, value);
    const response = await handle(
      new Request(`http://${req.headers.host}/mcp`, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  handle = mcpHttpHandler({
    hosts: [new URL(origin).host],
    authorize() {},
    createServer() {
      const mcp = new McpServer({ name: 'slow-healthy', version: '1' });
      mcp.registerTool(
        'slow',
        { inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { content: [{ type: 'text', text: 'finished' }] };
        },
      );
      return mcp;
    },
  });
  const client = upstreamClient(new URL(`${origin}/mcp`), '', undefined, {
    connectTimeoutMs: 100,
  });
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 1);
  const result = await client.callTool(
    { name: 'slow', arguments: {} },
    undefined,
    { timeout: 1000 },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: 'text', text: 'finished' }]);
});
