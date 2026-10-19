import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function bearer(request: Request): string {
  const match = /^Bearer ([^\s]{1,256})$/i.exec(
    request.headers.get('authorization') ?? '',
  );
  return match?.[1] ?? '';
}

export function checkServiceToken(actual: string, expected: string): boolean {
  if (!expected) throw new Error('An upstream service token is required');
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mcpHttpHandler(options: {
  hosts: string[];
  origins?: string[];
  authorize: (request: Request, body: unknown) => unknown;
  authorizationErrorStatus?: (error: unknown) => 401 | 503;
  createServer: (identity: unknown) => Server | McpServer;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin');
    if (
      !options.hosts.includes(new URL(request.url).host) ||
      (origin && !options.origins?.includes(origin))
    ) {
      return Response.json(
        { error: 'Disallowed host or origin' },
        { status: 403 },
      );
    }
    let body: unknown;
    if (request.method === 'POST') {
      const reader = request.body?.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          length += result.value.byteLength;
          if (length > 65536) {
            await reader.cancel();
            return Response.json(
              { error: 'Request too large' },
              { status: 413 },
            );
          }
          chunks.push(result.value);
        }
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
      }
    }
    let identity: unknown;
    try {
      identity = await options.authorize(request, body);
    } catch (error) {
      const status = options.authorizationErrorStatus?.(error) ?? 401;
      return Response.json(
        {
          error:
            status === 401
              ? 'Invalid or revoked credentials'
              : 'Authorization service unavailable',
        },
        { status },
      );
    }
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const server = options.createServer(identity);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        parsedBody: body,
      });
      // This first slice uses stateless JSON responses, not long-lived SSE streams.
      const bytes = await response.arrayBuffer();
      return new Response(bytes.byteLength ? bytes : null, {
        status: response.status,
        headers: response.headers,
      });
    } catch {
      return Response.json({ error: 'MCP request failed' }, { status: 500 });
    } finally {
      await server.close();
    }
  };
}

export function expressMcpApp(
  handler: (request: Request) => Promise<Response>,
  origin: string,
  ready: () => boolean | Promise<boolean> = () => true,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = randomUUID(),
      started = performance.now();
    res.setHeader('x-request-id', requestId);
    if (!req.path.startsWith('/health/'))
      res.on('finish', () =>
        console.log(
          JSON.stringify({
            event: 'http_request',
            requestId,
            method: req.method,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          }),
        ),
      );
    next();
  });
  app.get('/health/live', (_req, res) => res.json({ status: 'alive' }));
  app.get('/health/ready', async (_req, res) => {
    let healthy = false;
    try {
      healthy = await ready();
    } catch {
      /* Essential dependency is unavailable. */
    }
    res
      .status(healthy ? 200 : 503)
      .json({ status: healthy ? 'ready' : 'starting' });
  });
  app.all(
    '/mcp',
    express.raw({ type: '*/*', limit: '64kb' }),
    async (req, res) => {
      if (req.headers.host !== new URL(origin).host) {
        res.status(403).json({ error: 'Disallowed host' });
        return;
      }
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers))
          if (typeof value === 'string') headers.set(name, value);
        const request = new Request(new URL('/mcp', origin), {
          method: req.method,
          headers,
          ...(req.method === 'POST'
            ? { body: req.body?.length ? req.body : '{}' }
            : {}),
        });
        const response = await handler(request);
        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.status(500).json({ error: 'Request failed' });
      }
    },
  );
  app.use(
    (_err: unknown, _req: unknown, res: express.Response, _next: unknown) => {
      res.status(400).json({ error: 'Invalid or oversized request' });
    },
  );
  return app;
}
