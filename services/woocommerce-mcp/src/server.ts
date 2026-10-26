import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  bearer,
  checkServiceToken,
  mcpHttpHandler,
} from '../../../packages/shared/src/mcp-http.ts';
import { StoreRequestError } from './store-client.ts';
import type { WooStoreClient } from './store-client.ts';

const id = z.number().int().positive();
const page = z.number().int().positive().default(1);
const perPage = z.number().int().min(1).max(50).default(20);
const status = z.enum([
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid store response');
  return value as Record<string, unknown>;
}

function product(value: unknown) {
  const row = object(value);
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    status: row.status,
    permalink: row.permalink,
  };
}

function order(value: unknown) {
  const row = object(value);
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    currency: row.currency,
    date_created: row.date_created,
    date_created_gmt: row.date_created_gmt,
    line_items: Array.isArray(row.line_items)
      ? row.line_items.map((value) => {
          const line = object(value);
          return {
            product_id: line.product_id,
            name: line.name,
            quantity: line.quantity,
            total: line.total,
          };
        })
      : [],
  };
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function wooMcpServer(store: WooStoreClient): McpServer {
  // Preserve uncertain write outcomes across the MCP protocol, without retrying.
  async function mutation(work: () => Promise<unknown>) {
    try {
      return result(await work());
    } catch (error) {
      if (!(error instanceof StoreRequestError) || error.uncertain)
        return {
          isError: true,
          _meta: { 'storelink/outcome': 'uncertain' },
          content: [
            {
              type: 'text' as const,
              text: 'Store response lost; the change may have completed. Check before retrying.',
            },
          ],
        };
      throw error;
    }
  }
  const server = new McpServer({
    name: 'storelink-woocommerce',
    version: '0.1.0',
  });
  server.registerTool(
    'list_products',
    {
      description: 'List store products with prices and storefront URLs.',
      inputSchema: {
        page,
        per_page: perPage,
        search: z.string().max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = await store.request('GET', 'products', {
        page: args.page,
        per_page: args.per_page,
        ...(args.search ? { search: args.search } : {}),
      });
      if (!Array.isArray(rows)) throw new Error('Invalid store response');
      return result(rows.map(product));
    },
  );
  server.registerTool(
    'create_product',
    {
      description:
        'Create a published simple product. A timeout may leave a created product: check before retrying.',
      inputSchema: {
        name: z.string().min(1).max(200),
        price: z.string().regex(/^\d+(\.\d{1,2})?$/),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      mutation(async () =>
        product(
          await store.request(
            'POST',
            'products',
            {},
            {
              name: args.name,
              regular_price: args.price,
              type: 'simple',
              status: 'publish',
            },
          ),
        ),
      ),
  );
  server.registerTool(
    'list_orders',
    {
      description:
        'List orders with totals and items, excluding customer contact/address data. UTC after/before bounds are exclusive; use time get_day_window for today. Paginate until a page is shorter than per_page.',
      inputSchema: {
        page,
        per_page: perPage,
        after: z.string().datetime({ offset: true }).optional(),
        before: z.string().datetime({ offset: true }).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = await store.request('GET', 'orders', {
        page: args.page,
        per_page: args.per_page,
        dates_are_gmt: 'true',
        ...(args.after ? { after: args.after } : {}),
        ...(args.before ? { before: args.before } : {}),
      });
      if (!Array.isArray(rows)) throw new Error('Invalid store response');
      return result(rows.map(order));
    },
  );
  server.registerTool(
    'get_order',
    {
      description: 'Get one order without customer contact/address data.',
      inputSchema: { order_id: id },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      result(order(await store.request('GET', `orders/${args.order_id}`))),
  );
  server.registerTool(
    'update_order_status',
    {
      description:
        'Change an order status. This does not execute a payment refund.',
      inputSchema: { order_id: id, status },
      annotations: { readOnlyHint: false },
    },
    async (args) =>
      mutation(async () =>
        order(
          await store.request(
            'PUT',
            `orders/${args.order_id}`,
            {},
            { status: args.status },
          ),
        ),
      ),
  );
  return server;
}

export function wooHttpHandler(
  store: WooStoreClient,
  serviceToken: string,
  origin: string,
) {
  if (!serviceToken) throw new Error('A Woo MCP service token is required');
  return mcpHttpHandler({
    hosts: [new URL(origin).host],
    authorize(request) {
      if (!checkServiceToken(bearer(request), serviceToken))
        throw new Error('Unauthorized');
    },
    createServer: () => wooMcpServer(store),
  });
}
