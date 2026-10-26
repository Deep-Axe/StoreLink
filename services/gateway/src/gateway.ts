import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { hashApiKey } from '../../../packages/shared/src/api-keys.ts';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { GatewayStore, AuditOutcome } from './store.ts';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolClient = {
  listTools: (
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    schema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<CallToolResult>;
  ping?: (options?: {
    signal?: AbortSignal;
    timeout?: number;
  }) => Promise<unknown>;
};

export type Upstream = {
  id: string;
  teamId: string;
  slug: string;
  client: ToolClient;
  enabled: boolean;
  status: 'Connected' | 'Unreachable' | 'Disabled';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  generation: number;
};

type Route = {
  upstream: Upstream;
  tool: Tool;
  validate: (input: unknown) => boolean;
};

export class AuthorizationError extends Error {
  constructor() {
    super('Invalid or revoked gateway key');
  }
}

class DeadlineError extends Error {}

function toolAlias(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,46}$/.test(name)) return name;
  const base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 37) || 'tool';
  return `${base}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

async function deadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new DeadlineError('Upstream deadline exceeded'));
          controller.abort();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export class Gateway {
  store: GatewayStore;
  pepper: Uint8Array;
  discoveryMs: number;
  callMs: number;
  probeMs: number;
  retryMs: number;
  upstreams = new Map<string, Upstream>();
  private nextRetryAt = new Map<string, number>();
  routes = new Map<string, Route>();
  // Brings the registry up to date before each request, so a change made on
  // another replica applies to the next request here.
  beforeRequest?: () => Promise<void>;
  ajv = new Ajv({ strict: false, allErrors: false });
  private catalogListeners = new Set<(teamId: string) => void>();
  private catalogSnapshots = new Map<string, string>();
  private pendingCatalogs = new Set<string>();

  onCatalogChanged(listener: (teamId: string) => void): () => void {
    this.catalogListeners.add(listener);
    return () => {
      this.catalogListeners.delete(listener);
    };
  }
  private catalogChanged(teamId: string): void {
    if (this.pendingCatalogs.has(teamId)) return;
    this.pendingCatalogs.add(teamId);
    // Coalesce synchronous route replacement; unchanged discovery sends no event.
    queueMicrotask(() => {
      this.pendingCatalogs.delete(teamId);
      const snapshot = JSON.stringify(
        [...this.routes.entries()]
          .filter(
            ([, route]) =>
              route.upstream.teamId === teamId && route.upstream.enabled,
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, route]) => [name, route.tool]),
      );
      const previous = this.catalogSnapshots.get(teamId) ?? '[]';
      this.catalogSnapshots.set(teamId, snapshot);
      if (snapshot === previous) return;
      for (const listener of this.catalogListeners) listener(teamId);
    });
  }

  constructor(
    store: GatewayStore,
    pepper: Uint8Array,
    options: {
      discoveryMs?: number;
      callMs?: number;
      probeMs?: number;
      retryMs?: number;
    } = {},
  ) {
    // Validate the pepper before accepting any requests.
    hashApiKey('', pepper);
    this.store = store;
    this.pepper = pepper;
    this.discoveryMs = options.discoveryMs ?? 3000;
    this.callMs = options.callMs ?? 15000;
    this.probeMs = options.probeMs ?? 1000;
    this.retryMs = options.retryMs ?? 2000;
    addFormats.default(this.ajv);
  }

  async authenticate(key: string, requestedTool?: string): Promise<Identity> {
    const record = await this.store.findKey(hashApiKey(key, this.pepper));
    if (!record || record.revokedAt) {
      if (requestedTool !== undefined) {
        const id = await this.store.beginAudit(record, requestedTool);
        await this.store.finishAudit(id, {
          outcome: 'denied',
          reason: record ? 'key_revoked' : 'unauthenticated',
          durationMs: 0,
          serverId: record
            ? this.namespaceOwner(record.teamId, requestedTool)?.id
            : undefined,
        });
      }
      throw new AuthorizationError();
    }
    return record;
  }

  register(input: {
    id: string;
    teamId: string;
    slug: string;
    client: ToolClient;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    lastError?: string;
  }): void {
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(input.slug))
      throw new Error('Invalid server slug');
    if (
      this.upstreams.has(input.id) ||
      [...this.upstreams.values()].some(
        (u) => u.teamId === input.teamId && u.slug === input.slug,
      )
    ) {
      throw new Error('Server ID and team slug must be unique');
    }
    this.upstreams.set(input.id, {
      ...input,
      enabled: true,
      status: 'Unreachable',
      generation: 0,
    });
  }

  setEnabled(id: string, enabled: boolean): void {
    const upstream = this.upstreams.get(id);
    if (!upstream) throw new Error('Unknown upstream');
    upstream.enabled = enabled;
    upstream.generation++;
    upstream.status = enabled ? 'Unreachable' : 'Disabled';
    this.dropRoutes(id);
  }

  private dropRoutes(id: string): void {
    const teamId = this.upstreams.get(id)?.teamId;
    for (const [name, route] of this.routes)
      if (route.upstream.id === id) this.routes.delete(name);
    if (teamId) this.catalogChanged(teamId);
  }

  private failed(upstream: Upstream, reason: string): void {
    upstream.generation++;
    upstream.status = upstream.enabled ? 'Unreachable' : 'Disabled';
    upstream.lastFailureAt = new Date().toISOString();
    upstream.lastError = reason;
    // Hold the failure briefly so health reporting records it before recovery.
    this.nextRetryAt.set(upstream.id, Date.now() + this.retryMs);
    this.dropRoutes(upstream.id);
  }

  // Ping a connected upstream, or rediscover an unreachable one once its retry delay passes.
  async checkHealth(id: string): Promise<void> {
    const upstream = this.upstreams.get(id);
    if (!upstream || !upstream.enabled) return;
    if (upstream.status !== 'Connected') {
      if (Date.now() < (this.nextRetryAt.get(id) ?? 0)) return;
      this.nextRetryAt.set(id, Date.now() + this.retryMs);
      await this.refresh(id);
      return;
    }
    const client = upstream.client;
    if (!client.ping) return;
    const generation = upstream.generation;
    try {
      await deadline(
        (signal) => client.ping!({ signal, timeout: this.probeMs }),
        this.probeMs,
      );
    } catch {
      if (generation === upstream.generation)
        this.failed(upstream, 'Health check failed or timed out');
    }
  }

  async refresh(id: string): Promise<void> {
    const upstream = this.upstreams.get(id);
    if (!upstream || !upstream.enabled) return;
    const generation = ++upstream.generation;
    try {
      const tools = await deadline(async (signal) => {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = await upstream.client.listTools(
            { cursor },
            { signal, timeout: this.discoveryMs },
          );
          tools.push(...result.tools);
          if (tools.length > 200) throw new Error('Tool catalog exceeds limit');
          cursor = result.nextCursor;
          if (!cursor) return tools;
        }
        throw new Error('Too many tool catalog pages');
      }, this.discoveryMs);
      const snapshot = new Map<string, Route>();
      for (const tool of tools) {
        if (
          JSON.stringify(tool.inputSchema).length > 65536 ||
          (tool.description?.length ?? 0) > 4096
        ) {
          throw new Error('Tool metadata exceeds limit');
        }
        const name = `${upstream.slug}__${toolAlias(tool.name)}`;
        if (snapshot.has(name)) throw new Error('Tool aliases collide');
        snapshot.set(name, {
          upstream,
          tool,
          validate: this.ajv.compile(tool.inputSchema),
        });
      }
      if (generation !== upstream.generation || !upstream.enabled) return;
      this.dropRoutes(id);
      // Same public name is allowed in different teams; route storage is team scoped.
      for (const [name, route] of snapshot)
        this.routes.set(`${upstream.teamId}:${name}`, route);
      this.catalogChanged(upstream.teamId);
      upstream.status = 'Connected';
      upstream.lastSuccessAt = new Date().toISOString();
    } catch {
      if (generation === upstream.generation)
        this.failed(upstream, 'Discovery failed or timed out');
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      [...this.upstreams.keys()].map((id) => this.refresh(id)),
    );
  }

  async listTools(actor: Identity): Promise<Tool[]> {
    if (!(await this.store.isActive(actor))) throw new AuthorizationError();
    await this.beforeRequest?.();
    return [...this.routes.entries()]
      .filter(
        ([, route]) =>
          route.upstream.teamId === actor.teamId && route.upstream.enabled,
      )
      .map(([name, route]) => ({
        ...route.tool,
        name: name.slice(actor.teamId.length + 1),
      }));
  }

  // Attributes denied calls to the server whose namespace was requested. Audit only, never routing.
  namespaceOwner(teamId: string, name: string): Upstream | undefined {
    let owner: Upstream | undefined;
    for (const upstream of this.upstreams.values())
      if (
        upstream.teamId === teamId &&
        name.startsWith(`${upstream.slug}__`) &&
        upstream.slug.length > (owner?.slug.length ?? -1)
      )
        owner = upstream;
    return owner;
  }

  async call(
    actor: Identity,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    const started = performance.now();
    const auditId = await this.store.beginAudit(actor, name);
    let route: Route | undefined;
    let outcome: AuditOutcome = 'failed';
    let reason: string | undefined;
    try {
      if (!(await this.store.isActive(actor))) {
        outcome = 'denied';
        reason = 'key_revoked';
        throw new AuthorizationError();
      }
      reason = 'registry_unavailable';
      await this.beforeRequest?.();
      reason = undefined;
      route = this.routes.get(`${actor.teamId}:${name}`);
      if (!route || !route.upstream.enabled) {
        outcome = 'denied';
        reason = 'tool_unavailable';
        return {
          isError: true,
          content: [{ type: 'text', text: 'Tool is unavailable or disabled' }],
        };
      }
      if (!route.validate(args)) {
        reason = 'invalid_arguments';
        return {
          isError: true,
          content: [{ type: 'text', text: 'Invalid tool arguments' }],
        };
      }
      try {
        const result = await deadline(
          (signal) =>
            route!.upstream.client.callTool(
              { name: route!.tool.name, arguments: args },
              undefined,
              { signal, timeout: this.callMs },
            ),
          this.callMs,
        );
        if (JSON.stringify(result).length > 262144) {
          reason = 'result_too_large';
          return {
            isError: true,
            content: [
              { type: 'text', text: 'Tool result exceeds the response limit' },
            ],
          };
        }
        outcome = result.isError
          ? result._meta?.['storelink/outcome'] === 'uncertain' &&
            route.tool.annotations?.readOnlyHint !== true
            ? 'uncertain'
            : 'failed'
          : 'success';
        return result;
      } catch (error) {
        // Remote protocol/validation errors do not prove the server is unreachable.
        const protocolError =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          [-32600, -32601, -32602].includes(Number(error.code));
        const timeout =
          error instanceof DeadlineError ||
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === -32001);
        if (!protocolError)
          this.failed(
            route.upstream,
            timeout ? 'Tool call timed out' : 'Upstream connection failed',
          );
        outcome = protocolError
          ? 'failed'
          : route.tool.annotations?.readOnlyHint === true
            ? timeout
              ? 'timeout'
              : 'failed'
            : 'uncertain';
        reason = protocolError
          ? 'upstream_protocol_error'
          : timeout
            ? 'upstream_timeout'
            : 'upstream_failure';
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                outcome === 'uncertain'
                  ? 'Upstream response lost; the operation may have completed. Check before retrying.'
                  : 'Upstream failed or timed out',
            },
          ],
        };
      }
    } finally {
      await this.store.finishAudit(auditId, {
        outcome,
        reason,
        durationMs: performance.now() - started,
        serverId:
          route?.upstream.id ?? this.namespaceOwner(actor.teamId, name)?.id,
        toolName: route?.tool.name,
      });
    }
  }
}
