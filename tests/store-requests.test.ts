import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import {
  requestStore,
  StoreRequestError,
} from '../services/gateway/src/store-requests.ts';
import type { Identity } from '../packages/shared/src/api-keys.ts';

const user: Identity = {
  userId: 'alice',
  teamId: 'team',
  role: 'member',
  keyId: 'key',
};
const settings = {
  hostSuffix: 'test.localhost',
  scheme: 'http' as const,
  maxPerUser: 3,
  maxPerTeam: 3,
  provisionTimeoutMs: 240000,
};
type Record = { team: string; owner: string; slug?: string; status?: string };
function fixture(existing: Record[]) {
  const records = [...existing];
  let tail = Promise.resolve();
  let rollbacks = 0;
  const pool = {
    async connect() {
      let release: (() => void) | undefined;
      let pending: Record | undefined;
      return {
        async query(sql: string, args: unknown[] = []) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) {
            const previous = tail;
            tail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
            return { rows: [] };
          }
          if (sql === 'SELECT status FROM stores WHERE slug=$1')
            return {
              rows: records
                .filter((r) => r.slug === args[0])
                .map((r) => ({ status: r.status })),
            };
          if (sql.includes('count(*) AS total')) {
            const team = records.filter((r) => r.team === args[0]);
            return {
              rows: [
                {
                  total: String(team.length),
                  mine: String(team.filter((r) => r.owner === args[1]).length),
                },
              ],
            };
          }
          if (sql.includes('SELECT 1 FROM upstream_servers'))
            return { rows: [], rowCount: 0 };
          if (sql.includes('INSERT INTO stores')) {
            pending = {
              team: String(args[1]),
              owner: String(args[2]),
              slug: String(args[3]),
              status: 'Provisioning',
            };
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('pg_notify')) return { rows: [] };
          if (sql === 'COMMIT') {
            if (pending) records.push(pending);
            release?.();
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            rollbacks++;
            release?.();
            return { rows: [] };
          }
          throw new Error('Unexpected query');
        },
        release() {
          release?.();
        },
      };
    },
  } as unknown as Pick<Pool, 'connect'>;
  return { pool, records, rollbacks: () => rollbacks };
}

test('concurrent gateway requests admit exactly one store when a team has one slot', async () => {
  const f = fixture([
    { team: 'team', owner: 'other' },
    { team: 'team', owner: 'other' },
  ]);
  const results = await Promise.allSettled(
    ['north', 'south'].map((slug) =>
      requestStore(f.pool, user, { slug, displayName: slug }, settings),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.records.length, 3);
  const rejected = results.find(
    (r) => r.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof StoreRequestError);
  assert.equal(rejected.reason.status, 409);
  assert.equal(f.rollbacks(), 1);
});
test('store admission enforces per-user limits independently of another team and releases the transaction', async () => {
  const f = fixture([
    { team: 'team', owner: 'alice' },
    { team: 'other', owner: 'alice' },
  ]);
  await assert.rejects(
    () =>
      requestStore(
        f.pool,
        user,
        { slug: 'north', displayName: 'North' },
        { ...settings, maxPerUser: 1 },
      ),
    /You can have 1 stores/,
  );
  await requestStore(
    f.pool,
    { ...user, userId: 'bob' },
    { slug: 'south', displayName: 'South' },
    { ...settings, maxPerUser: 1 },
  );
  assert.equal(f.records.length, 3);
  assert.equal(f.rollbacks(), 1);
});

test('a deleting address reports termination across teams and can be reused after removal', async () => {
  for (const team of ['team', 'another-team']) {
    const f = fixture([
      { team, owner: 'other', slug: 'north', status: 'Deleting' },
    ]);
    await assert.rejects(
      () =>
        requestStore(
          f.pool,
          user,
          { slug: 'north', displayName: 'North' },
          { ...settings, maxPerTeam: 1 },
        ),
      (error) =>
        error instanceof StoreRequestError &&
        error.status === 409 &&
        error.message ===
          'That store address is still being removed; wait a moment and try again',
    );
    assert.equal(f.records.length, 1);
    assert.equal(f.rollbacks(), 1);
    f.records.length = 0;
    await requestStore(
      f.pool,
      user,
      { slug: 'north', displayName: 'North' },
      { ...settings, maxPerTeam: 1 },
    );
    assert.equal(f.records.length, 1);
  }
});
