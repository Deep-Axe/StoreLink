import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { bearer, readMcpBody } from '../../../packages/shared/src/mcp-http.ts';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { Gateway } from './gateway.ts';
import { AuthorizationError } from './gateway.ts';
import { MemorySessions } from './mcp-sessions.ts';
import { MemoryRateLimiter } from './rate-limits.ts';
import type { RateLimiter } from './rate-limits.ts';
import type { McpSessionRecord, McpSessionStore } from './mcp-sessions.ts';

// Each replica keeps a local MCP server per session it has handled. The shared
// session store is authoritative, so any replica can resume any session.
type Local = {
  actor: Identity;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
};

export function gatewayHttpHandler(
  gateway: Gateway,
  origin: string,
  options: {
    sessionTtlMs?: number;
    maxSessions?: number;
    maxUserSessions?: number;
    now?: () => number;
    sessions?: McpSessionStore;
    rateLimiter?: RateLimiter;
    requestsPerMinute?: number;
  } = {},
) {
  const locals = new Map<string, Local>();
  const resuming = new Map<string, Promise<Local>>();
  const store = options.sessions ?? new MemorySessions();
  const ttl = options.sessionTtlMs ?? 15 * 60 * 1000;
  const maximum = options.maxSessions ?? 256;
  const perUser = options.maxUserSessions ?? 8;
  const now = options.now ?? Date.now;
  const limiter = options.rateLimiter ?? new MemoryRateLimiter();
  const perMinute = options.requestsPerMinute ?? 120;
  if (
    [ttl, maximum, perUser, perMinute].some(
      (n) => !Number.isSafeInteger(n) || n < 1,
    )
  )
    throw new Error('Invalid MCP session limits');
  async function drop(id: string) {
    const local = locals.get(id);
    if (!local) return;
    locals.delete(id);
    await local.server.close();
  }
  function expire() {
    for (const [id, local] of locals)
      if (now() - local.lastUsed >= ttl) void drop(id).catch(() => {});
    void store.expire(now(), ttl).catch(() => {});
  }
  const timer = setInterval(expire, Math.min(ttl, 30000));
  timer.unref();
  function create(id: string, actor: Identity): Local {
    const server = new Server(
      { name: 'storelink-gateway', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await gateway.listTools(actor),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      gateway.call(actor, request.params.name, request.params.arguments),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      // Called for DELETE /mcp: the session ends on every replica.
      onsessionclosed: async () => {
        locals.delete(id);
        await store.delete(id);
      },
    });
    return { actor, server, transport, lastUsed: now() };
  }
  // Replays the client's initialize handshake into a new local server.
  async function resume(record: McpSessionRecord, actor: Identity) {
    const local = create(record.id, actor);
    try {
      await local.server.connect(local.transport);
      const url = new URL('/mcp', origin);
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      const initialized = await local.transport.handleRequest(
        new Request(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: record.init,
          }),
        }),
      );
      const version = (
        (await initialized.json()) as { result?: { protocolVersion?: string } }
      ).result?.protocolVersion;
      if (!initialized.ok || !version) throw new Error('Resume failed');
      if (record.ready) {
        const ready = await local.transport.handleRequest(
          new Request(url, {
            method: 'POST',
            headers: {
              ...headers,
              'mcp-session-id': record.id,
              'mcp-protocol-version': version,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
            }),
          }),
        );
        if (!ready.ok) throw new Error('Resume failed');
      }
      return local;
    } catch (error) {
      await local.server.close();
      throw error;
    }
  }
  function localSession(record: McpSessionRecord, actor: Identity) {
    const existing = locals.get(record.id);
    if (existing) return Promise.resolve(existing);
    let pending = resuming.get(record.id);
    if (!pending) {
      pending = resume(record, actor)
        .then((local) => {
          locals.set(record.id, local);
          return local;
        })
        .finally(() => resuming.delete(record.id));
      resuming.set(record.id, pending);
    }
    return pending;
  }
  const unsubscribe = gateway.onCatalogChanged((teamId) => {
    void Promise.allSettled(
      [...locals]
        .filter(([, local]) => local.actor.teamId === teamId)
        .map(async ([id, local]) => {
          // Readiness comes from the store: the client may have completed the
          // handshake through another replica.
          const record = await store.get(id, now(), ttl);
          if (!record || !(await gateway.store.isActive(local.actor))) {
            await drop(id);
            return;
          }
          if (!record.ready) return;
          await local.server.notification({
            method: 'notifications/tools/list_changed',
          });
        }),
    );
  });
  const handler = async (request: Request): Promise<Response> => {
    if (
      new URL(request.url).host !== new URL(origin).host ||
      (request.headers.has('origin') &&
        request.headers.get('origin') !== origin)
    )
      return Response.json(
        { error: 'Disallowed host or origin' },
        { status: 403 },
      );
    const parsed = await readMcpBody(request);
    if ('response' in parsed) return parsed.response;
    const { body } = parsed;
    const rpc = body as
      | { method?: string; params?: { name?: unknown } }
      | undefined;
    const requestedTool =
      rpc?.method === 'tools/call'
        ? typeof rpc.params?.name === 'string'
          ? rpc.params.name
          : '(invalid tool name)'
        : undefined;
    let actor: Identity;
    try {
      actor = await gateway.authenticate(bearer(request), requestedTool);
      if (!(await gateway.store.isActive(actor)))
        throw new AuthorizationError();
    } catch (error) {
      const status = error instanceof AuthorizationError ? 401 : 503;
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
    if (
      request.method === 'POST' &&
      !(await limiter.hit(`mcp-key:${actor.keyId}`, perMinute, 60000))
    ) {
      if (requestedTool !== undefined) {
        const audit = await gateway.store.beginAudit(actor, requestedTool);
        await gateway.store.finishAudit(audit, {
          outcome: 'denied',
          reason: 'rate_limited',
          durationMs: 0,
          serverId: gateway.namespaceOwner(actor.teamId, requestedTool)?.id,
        });
      }
      return Response.json(
        { error: 'Too many requests for this API key; slow down' },
        { status: 429, headers: { 'retry-after': '60' } },
      );
    }
    const id = request.headers.get('mcp-session-id');
    if (id) {
      const record = await store.get(id, now(), ttl);
      if (!record) {
        await drop(id);
        return Response.json(
          { error: 'MCP session expired; reconnect' },
          { status: 404 },
        );
      }
      if (
        record.userId !== actor.userId ||
        record.teamId !== actor.teamId ||
        record.keyId !== actor.keyId
      ) {
        if (requestedTool !== undefined) {
          const audit = await gateway.store.beginAudit(actor, requestedTool);
          await gateway.store.finishAudit(audit, {
            outcome: 'denied',
            reason: 'session_owner_mismatch',
            durationMs: 0,
            serverId: gateway.namespaceOwner(actor.teamId, requestedTool)?.id,
          });
        }
        return Response.json(
          { error: 'Session belongs to another credential' },
          { status: 403 },
        );
      }
      let local: Local;
      try {
        local = await localSession(record, actor);
      } catch {
        return Response.json(
          { error: 'MCP session could not be resumed; reconnect' },
          { status: 404 },
        );
      }
      local.lastUsed = now();
      await store.touch(id, now());
      const response = await local.transport.handleRequest(request, {
        parsedBody: body,
      });
      if (rpc?.method === 'notifications/initialized' && response.ok)
        await store.touch(id, now(), true);
      return response;
    }
    if (request.method !== 'POST' || !isInitializeRequest(body))
      return Response.json(
        { error: 'Initialize a new MCP session first' },
        { status: 400 },
      );
    const newId = randomUUID();
    if (
      !(await store.create(
        {
          id: newId,
          userId: actor.userId,
          teamId: actor.teamId,
          keyId: actor.keyId,
          init: body.params,
        },
        now(),
        ttl,
        { total: maximum, perUser },
      ))
    )
      return Response.json(
        {
          error:
            'Too many MCP sessions; close unused sessions or wait for expiry',
        },
        { status: 429 },
      );
    const local = create(newId, actor);
    locals.set(newId, local);
    try {
      await local.server.connect(local.transport);
      const response = await local.transport.handleRequest(request, {
        parsedBody: body,
      });
      if (!response.ok) {
        await drop(newId);
        await store.delete(newId);
      }
      return response;
    } catch {
      await drop(newId);
      await store.delete(newId);
      return Response.json(
        { error: 'MCP initialization failed' },
        { status: 500 },
      );
    }
  };
  return Object.assign(handler, {
    async close() {
      clearInterval(timer);
      unsubscribe();
      await Promise.allSettled([...locals.keys()].map(drop));
    },
  });
}
