import { Temporal } from '@js-temporal/polyfill';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function dayWindow(
  timezone: string,
  date?: string,
  now = Temporal.Now.instant(),
) {
  const day = date
    ? Temporal.PlainDate.from(date)
    : now.toZonedDateTimeISO(timezone).toPlainDate();
  const start = day.toZonedDateTime(timezone).toInstant();
  const end = day.add({ days: 1 }).toZonedDateTime(timezone).toInstant();
  return {
    timezone,
    date: day.toString(),
    start_utc: start.toString(),
    end_exclusive_utc: end.toString(),
    after: start.subtract({ seconds: 1 }).toString(),
    before: end.toString(),
    note: 'Pass after/before to woo list_orders. Its bounds are exclusive and timestamps have one-second precision; after is one second before midnight.',
  };
}
export function timeServer(timezone: string): McpServer {
  const server = new McpServer({ name: 'storelink-time', version: '0.1.0' });
  server.registerTool(
    'get_day_window',
    {
      description:
        'Get today’s UTC date filters for WooCommerce orders in the configured store timezone. Also supports a specified date and IANA timezone.',
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        timezone: z.string().max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(dayWindow(args.timezone ?? timezone, args.date)),
        },
      ],
    }),
  );
  server.registerTool(
    'get_status',
    {
      description:
        'Read the time service status and configured store timezone.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            service: 'time',
            timezone,
            now: new Date().toISOString(),
          }),
        },
      ],
    }),
  );
  return server;
}
