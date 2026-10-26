import { readFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.argv.includes('--show')) {
  console.log(
    'Run with --show in your own terminal to display local dashboard and WordPress bootstrap passwords. Do not share the output.',
  );
} else {
  const data = JSON.parse(
    readFileSync(
      join(process.env.STORELINK_STATE_DIR ?? '.data', 'cluster-secrets.json'),
      'utf8',
    ),
  ) as Record<string, string>;
  const get = (key: string) =>
    Buffer.from(data[key], 'base64').toString('utf8');
  console.log(
    JSON.stringify(
      {
        dashboard: [
          {
            email: 'admin@storelink.local',
            password: get('dashboard-admin-password'),
          },
          {
            email: 'member@storelink.local',
            password: get('dashboard-member-password'),
          },
        ],
        wordpress: {
          username: 'admin',
          password: get('wordpress-admin-password'),
        },
      },
      null,
      2,
    ),
  );
}
