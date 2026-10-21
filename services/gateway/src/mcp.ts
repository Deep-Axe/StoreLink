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

type Session = {
  actor: Identity;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
  ready: boolean;
};

export function gatewayHttpHandler(
  gateway: Gateway,
  origin: string,
  options: {
    sessionTtlMs?: number;
    maxSessions?: number;
    maxUserSessions?: number;
    now?: () => number;
  } = {},
) {
  const sessions = new Map<string, Session>();
  const ttl = options.sessionTtlMs ?? 15 * 60 * 1000;
  const maximum = options.maxSessions ?? 256;
  const perUser = options.maxUserSessions ?? 8;
  const now = options.now ?? Date.now;
  if ([ttl, maximum, perUser].some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error('Invalid MCP session limits');
  async function remove(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await session.server.close();
  }
  function expire() {
    for (const [id, session] of sessions)
      if (now() - session.lastUsed >= ttl) void remove(id).catch(() => {});
  }
  const timer = setInterval(expire, Math.min(ttl, 30000));
  timer.unref();
  const unsubscribe = gateway.onCatalogChanged((teamId) => {
    void Promise.allSettled(
      [...sessions]
        .filter(([, s]) => s.ready && s.actor.teamId === teamId)
        .map(async ([id, session]) => {
          if (
            now() - session.lastUsed >= ttl ||
            !(await gateway.store.isActive(session.actor))
          ) {
            await remove(id);
            return;
          }
          await session.server.notification({
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
    expire();
    const id = request.headers.get('mcp-session-id');
    let session = id ? sessions.get(id) : undefined;
    if (id && !session)
      return Response.json(
        { error: 'MCP session expired; reconnect' },
        { status: 404 },
      );
    if (
      session &&
      (session.actor.userId !== actor.userId ||
        session.actor.teamId !== actor.teamId ||
        session.actor.keyId !== actor.keyId)
    ) {
      if (requestedTool !== undefined) {
        const audit = await gateway.store.beginAudit(actor, requestedTool);
        await gateway.store.finishAudit(audit, {
          outcome: 'denied',
          reason: 'session_owner_mismatch',
          durationMs: 0,
        });
      }
      return Response.json(
        { error: 'Session belongs to another credential' },
        { status: 403 },
      );
    }
    if (!session) {
      if (request.method !== 'POST' || !isInitializeRequest(body))
        return Response.json(
          { error: 'Initialize a new MCP session first' },
          { status: 400 },
        );
      if (
        sessions.size >= maximum ||
        [...sessions.values()].filter(
          (s) =>
            s.actor.userId === actor.userId && s.actor.teamId === actor.teamId,
        ).length >= perUser
      )
        return Response.json(
          {
            error:
              'Too many MCP sessions; close unused sessions or wait for expiry',
          },
          { status: 429 },
        );
      const newId = randomUUID();
      const server = new Server(
        { name: 'urumi-gateway', version: '0.1.0' },
        { capabilities: { tools: { listChanged: true } } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: await gateway.listTools(actor),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        gateway.call(actor, request.params.name, request.params.arguments),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
        enableJsonResponse: true,
        onsessionclosed: () => {
          sessions.delete(newId);
        },
      });
      session = { actor, server, transport, lastUsed: now(), ready: false };
      sessions.set(newId, session);
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request, {
          parsedBody: body,
        });
        if (!response.ok) await remove(newId);
        return response;
      } catch {
        await remove(newId);
        return Response.json(
          { error: 'MCP initialization failed' },
          { status: 500 },
        );
      }
    }
    session.lastUsed = now();
    const response = await session.transport.handleRequest(request, {
      parsedBody: body,
    });
    if (rpc?.method === 'notifications/initialized' && response.ok)
      session.ready = true;
    return response;
  };
  return Object.assign(handler, {
    async close() {
      clearInterval(timer);
      unsubscribe();
      await Promise.allSettled([...sessions.keys()].map(remove));
    },
  });
}
