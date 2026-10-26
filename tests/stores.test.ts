import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  storeManifests,
  storeNames,
  storeSecret,
} from '../services/gateway/src/store-manifests.ts';
import type { StoreSettings } from '../services/gateway/src/store-manifests.ts';
import { StoreCluster } from '../services/gateway/src/k8s-client.ts';
import type { KubeResponse } from '../services/gateway/src/k8s-client.ts';
import { UpstreamPolicy } from '../services/gateway/src/upstream-policy.ts';
import {
  StoreProvisioner,
  storeMcpToken,
} from '../services/gateway/src/store-provisioner.ts';
import type { StoreRecord } from '../services/gateway/src/store-provisioner.ts';

const resources = {
  requests: { cpu: '50m', memory: '64Mi' },
  limits: { cpu: '1', memory: '256Mi' },
};
export const settings: StoreSettings = {
  images: {
    app: 'storelink-app:1',
    store: 'storelink-wordpress:1',
    mariadb: 'mariadb:11.8',
    pullPolicy: 'IfNotPresent',
  },
  hostSuffix: 'store.storelink.localhost',
  scheme: 'http',
  ingressClass: 'traefik',
  storageClass: 'local-path',
  storage: { wordpress: '2Gi', mariadb: '1Gi' },
  timezone: 'Asia/Kolkata',
  woocommerceVersion: '11.2.1',
  gateway: { namespace: 'storelink', instance: 'storelink' },
  healthPhp: '<?php echo 1;',
  resources: { wordpress: resources, mariadb: resources, wooMcp: resources },
};

type Obj = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: any;
};
const env = (container: any, name: string) =>
  container.env.find((e: { name: string }) => e.name === name)?.value;

test('every address a store uses comes from its slug', () => {
  const names = storeNames('north', settings);
  assert.deepEqual(names, {
    namespace: 'storelink-store-north',
    host: 'north.store.storelink.localhost',
    publicUrl: 'http://north.store.storelink.localhost',
    mcpOrigin: 'http://woo-mcp.storelink-store-north.svc.cluster.local:3001',
    mcpUrl: 'http://woo-mcp.storelink-store-north.svc.cluster.local:3001/mcp',
    upstreamSlug: 'woo-north',
  });
  for (const slug of ['North', '1st', 'a'.repeat(13), '../x', 'a_b', ''])
    assert.throws(() => storeNames(slug, settings), /Invalid store slug/);
  // The gateway approves exactly this origin form, and only when enabled.
  assert.ok(new UpstreamPolicy([], undefined, true).approved(names.mcpOrigin));
  assert.ok(!new UpstreamPolicy([]).approved(names.mcpOrigin));
  for (const origin of [
    'http://woo-mcp.storelink-store-north.svc.cluster.local:3002',
    'http://wordpress.storelink-store-north.svc.cluster.local:3001',
    'http://woo-mcp.storelink.svc.cluster.local:3001',
    'https://woo-mcp.storelink-store-north.svc.cluster.local:3001',
  ])
    assert.ok(
      !new UpstreamPolicy([], undefined, true).approved(origin),
      origin,
    );
});

test('store manifests stay inside the store namespace and agree on addresses', () => {
  const { names, objects, jobName } = storeManifests('north', settings);
  const all = objects as Obj[];
  for (const object of all)
    assert.equal(
      object.kind === 'Namespace'
        ? object.metadata.name
        : object.metadata.namespace,
      names.namespace,
    );
  assert.ok(
    !all.some((o) => o.kind === 'Secret'),
    'Secrets are created separately',
  );
  assert.equal(
    all.find((o) => o.kind === 'Namespace')!.metadata.labels![
      'storelink/managed-store'
    ],
    'true',
  );
  const workloads = all.filter((o) => ['Deployment', 'Job'].includes(o.kind));
  const containers = workloads.flatMap((o) =>
    o.spec.template.spec.containers.map((c: any) => ({
      kind: o.kind,
      c,
      pod: o.spec.template.spec,
    })),
  );
  assert.equal(containers.length, 4);
  for (const { kind, c, pod } of containers) {
    assert.ok(c.resources.requests && c.resources.limits, c.name);
    assert.equal(pod.securityContext.runAsNonRoot, true, c.name);
    assert.equal(pod.automountServiceAccountToken, false, c.name);
    // A Service named woo-mcp would otherwise inject WOO_MCP_PORT=tcp://...
    assert.equal(pod.enableServiceLinks, false, c.name);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL'], c.name);
    if (kind === 'Deployment')
      assert.ok(c.readinessProbe && c.livenessProbe, c.name);
  }
  const byName = (name: string) =>
    containers.find(({ c }) => c.name === name)!.c;
  assert.equal(env(byName('woo-mcp'), 'WOO_MCP_ORIGIN'), names.mcpOrigin);
  for (const name of ['woo-mcp', 'wordpress', 'bootstrap'])
    assert.equal(env(byName(name), 'STORE_PUBLIC_URL'), names.publicUrl, name);
  const ingress = all.find((o) => o.kind === 'Ingress')!;
  assert.equal(ingress.spec.rules[0].host, names.host);
  assert.ok(all.some((o) => o.kind === 'Job' && o.metadata.name === jobName));
  // A new image gives the immutable bootstrap Job a new name.
  const updated = storeManifests('north', {
    ...settings,
    images: { ...settings.images, store: 'storelink-wordpress:2' },
  });
  assert.notEqual(updated.jobName, jobName);
});

test('store network policies admit only the gateway and the store itself', () => {
  const policies = (storeManifests('north', settings).objects as Obj[]).filter(
    (o) => o.kind === 'NetworkPolicy',
  );
  const deny = policies.find((p) => p.metadata.name === 'default-deny')!;
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(deny.spec.policyTypes, ['Ingress', 'Egress']);
  const mcp = policies.find((p) => p.metadata.name === 'woo-mcp')!;
  assert.deepEqual(mcp.spec.ingress[0].from, [
    {
      namespaceSelector: {
        matchLabels: { 'kubernetes.io/metadata.name': 'storelink' },
      },
      podSelector: {
        matchLabels: {
          'storelink/component': 'gateway',
          'app.kubernetes.io/instance': 'storelink',
        },
      },
    },
  ]);
  // Peers within the store are selected by store and component, never by namespace.
  for (const policy of policies)
    for (const rule of [
      ...(policy.spec.ingress ?? []),
      ...(policy.spec.egress ?? []),
    ])
      for (const peer of rule.from ?? rule.to ?? [])
        if (!peer.namespaceSelector)
          assert.equal(
            peer.podSelector.matchLabels['storelink/store'],
            'north',
          );
});

test('store secrets are random per store', () => {
  const a = storeSecret('north', settings).stringData;
  const b = storeSecret('north', settings).stringData;
  assert.notEqual(a['woo-mcp-token'], b['woo-mcp-token']);
  assert.match(a['woo-consumer-key'], /^ck_[0-9a-f]{40}$/);
});

test('the cluster client refuses namespaces outside the store pattern', async () => {
  const calls: { method: string; path: string; type?: string }[] = [];
  let namespaceLabels: Record<string, string> | undefined;
  const cluster = new StoreCluster({
    async request(method, path, _body, type): Promise<KubeResponse> {
      calls.push({ method, path, type });
      if (method === 'GET')
        return namespaceLabels
          ? {
              status: 200,
              body: { metadata: { name: 'x', labels: namespaceLabels } },
            }
          : { status: 404, body: {} };
      return { status: 200, body: {} };
    },
  });
  for (const namespace of ['storelink', 'kube-system', 'default'])
    await assert.rejects(
      cluster.apply({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'x', namespace },
      }),
      /outside store namespaces/,
    );
  await assert.rejects(cluster.deleteNamespace('kube-system'), /outside store/);
  assert.equal(calls.length, 0);

  await cluster.apply(storeManifests('north', settings).objects[0] as Obj);
  assert.equal(
    calls[0].path,
    '/api/v1/namespaces/storelink-store-north?fieldManager=storelink-provisioner&force=true',
  );
  assert.equal(calls[0].type, 'application/apply-patch+yaml');

  // A namespace with a store-like name but without the managed label is kept.
  namespaceLabels = {};
  await assert.rejects(
    cluster.deleteNamespace('storelink-store-north'),
    /does not manage/,
  );
  namespaceLabels = { 'storelink/managed-store': 'true' };
  assert.equal(
    await cluster.deleteNamespace('storelink-store-north'),
    'deleting',
  );
  assert.equal(calls.at(-1)!.method, 'DELETE');
  namespaceLabels = undefined;
  assert.equal(await cluster.deleteNamespace('storelink-store-north'), 'gone');
});

// A provisioner wired to in-memory fakes of the cluster, database and gateway.
function provisionerFixture() {
  let now = 0;
  const store: StoreRecord = {
    id: 's1',
    teamId: 'team',
    slug: 'north',
    displayName: 'North',
    status: 'Provisioning',
    deadlineAt: 240000,
  };
  const updates: [string, string, string | null][] = [];
  const events: string[] = [];
  const state = {
    secretExists: false,
    credential: false,
    available: new Set<string>(),
    job: undefined as undefined | 'succeeded' | 'failed',
    namespace: 'present' as 'present' | 'deleting' | 'gone',
    removed: false,
  };
  const provisioner = new StoreProvisioner({
    settings,
    now: () => now,
    repository: {
      async active() {
        return store.status === 'Provisioning' || store.status === 'Deleting'
          ? [{ ...store }]
          : [];
      },
      async update(_id, from, to, reason) {
        if (store.status !== from) return;
        store.status = to;
        updates.push([from, to, reason]);
      },
      async remove() {
        state.removed = true;
      },
    },
    registrar: {
      async hasCredential() {
        return state.credential;
      },
      async saveCredential() {
        state.credential = true;
        events.push('credential');
      },
      async register(_store, url, slug) {
        events.push(`register ${slug} ${url}`);
      },
      async unregister() {
        events.push('unregister');
      },
    },
    cluster: {
      async apply(object: { kind: string }) {
        events.push(`apply ${object.kind}`);
        return {};
      },
      async create() {
        if (state.secretExists) return false;
        state.secretExists = true;
        return true;
      },
      async get(object: { kind: string; metadata: { name: string } }) {
        if (object.kind === 'Deployment')
          return {
            status: {
              availableReplicas: state.available.has(object.metadata.name)
                ? 1
                : 0,
            },
          };
        if (!state.job) return { status: {} };
        return state.job === 'succeeded'
          ? { status: { succeeded: 1 } }
          : {
              status: {
                conditions: [
                  {
                    type: 'Failed',
                    status: 'True',
                    message: 'BackoffLimitExceeded',
                  },
                ],
              },
            };
      },
      async deleteNamespace() {
        if (state.namespace === 'present') state.namespace = 'deleting';
        return state.namespace === 'gone' ? 'gone' : 'deleting';
      },
    } as never,
  });
  return {
    store,
    updates,
    events,
    state,
    provisioner,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a store becomes Ready once its workloads and setup finish, then registers', async () => {
  const f = provisionerFixture();
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Provisioning');
  assert.ok(f.events.includes('credential'));
  assert.equal(f.events.filter((e) => e === 'apply Namespace').length, 1);
  // Later passes only check readiness; nothing is applied twice.
  f.state.available = new Set(['mariadb', 'wordpress', 'woo-mcp']);
  await f.provisioner.reconcile();
  assert.equal(f.events.filter((e) => e === 'apply Namespace').length, 1);
  assert.equal(f.store.status, 'Provisioning');
  f.state.job = 'succeeded';
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Ready');
  assert.ok(
    f.events.includes(
      'register woo-north http://woo-mcp.storelink-store-north.svc.cluster.local:3001/mcp',
    ),
  );
});

test('provisioning fails with a reason on a deadline, a failed setup or lost credentials', async () => {
  const late = provisionerFixture();
  await late.provisioner.reconcile();
  late.advance(240001);
  await late.provisioner.reconcile();
  assert.equal(late.store.status, 'Failed');
  assert.match(
    late.updates.at(-1)![2]!,
    /deadline; waiting for mariadb, wordpress, woo-mcp, store setup/,
  );

  const broken = provisionerFixture();
  broken.state.job = 'failed';
  await broken.provisioner.reconcile();
  assert.equal(broken.store.status, 'Failed');
  assert.match(
    broken.updates.at(-1)![2]!,
    /Store setup failed: BackoffLimitExceeded/,
  );

  // The Secret survived a restart but the gateway never received its copy.
  const lost = provisionerFixture();
  lost.state.secretExists = true;
  await lost.provisioner.reconcile();
  assert.equal(lost.store.status, 'Failed');
  assert.match(lost.updates.at(-1)![2]!, /no copy/);
});

test('deleting a store unregisters it and removes the row once the namespace is gone', async () => {
  const f = provisionerFixture();
  f.store.status = 'Deleting';
  await f.provisioner.reconcile();
  assert.deepEqual(f.events, ['unregister']);
  assert.equal(f.state.removed, false);
  f.state.namespace = 'gone';
  await f.provisioner.reconcile();
  assert.equal(f.state.removed, true);
});

test('a status change never overwrites a concurrent delete', async () => {
  const f = provisionerFixture();
  f.state.available = new Set(['mariadb', 'wordpress', 'woo-mcp']);
  f.state.job = 'succeeded';
  // The pass read the store as Provisioning, then it was deleted before it finished.
  const snapshot = { ...f.store };
  f.store.status = 'Deleting';
  f.provisioner.repository.active = async () => [snapshot];
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Deleting');
});

test('retry gives a failed bootstrap a new attempt without replacing database credentials', async () => {
  const f = provisionerFixture();
  f.state.available = new Set(['mariadb', 'wordpress', 'woo-mcp']);
  f.state.job = 'failed';
  const original = storeManifests(
    f.store.slug,
    settings,
    f.store.displayName,
    1,
  ).jobName;
  const get = f.provisioner.cluster.get.bind(f.provisioner.cluster);
  f.provisioner.cluster.get = async (object) =>
    object.kind === 'Job' && object.metadata.name === original
      ? { status: { conditions: [{ type: 'Failed', status: 'True' }] } }
      : get(object);
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Failed');
  f.store.status = 'Provisioning';
  f.store.attempt = 2;
  f.state.job = 'succeeded';
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Ready');
  assert.notEqual(
    storeManifests(f.store.slug, settings, f.store.displayName, 2).jobName,
    original,
  );
  assert.equal(f.events.filter((e) => e === 'credential').length, 1);
});

test('new-store MCP tokens recover a crash after Secret creation without reading store passwords', async () => {
  const f = provisionerFixture();
  const key = Buffer.alloc(32, 7);
  f.store.tokenVersion = 1;
  f.provisioner.tokenKey = key;
  const tokens: string[] = [];
  let interrupted = true;
  f.provisioner.registrar.saveCredential = async (_store, token) => {
    tokens.push(token);
    if (interrupted) {
      interrupted = false;
      throw new Error('interrupted');
    }
    f.state.credential = true;
  };
  await f.provisioner.reconcile();
  assert.equal(f.state.secretExists, true);
  assert.equal(f.state.credential, false);
  const restarted = new StoreProvisioner({
    settings,
    repository: f.provisioner.repository,
    cluster: f.provisioner.cluster,
    registrar: f.provisioner.registrar,
    tokenKey: key,
    now: () => 0,
  });
  f.state.available = new Set(['mariadb', 'wordpress', 'woo-mcp']);
  f.state.job = 'succeeded';
  await restarted.reconcile();
  assert.equal(f.store.status, 'Ready');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0], tokens[1]);
  assert.equal(tokens[0], storeMcpToken(key, f.store.id));
  assert.notEqual(tokens[0], storeMcpToken(key, 'other-store'));
  assert.throws(() => storeMcpToken(undefined, 'id'), /32 random bytes/);
});

test('HTTPS stores request their own certificate and remain Provisioning until it is Ready', async () => {
  const f = provisionerFixture();
  f.provisioner.settings = {
    ...settings,
    scheme: 'https',
    tlsSecretName: 'storefront-tls',
    tlsClusterIssuer: 'test-issuer',
  };
  const objects = storeManifests('north', f.provisioner.settings)
    .objects as Obj[];
  const ingress = objects.find((o) => o.kind === 'Ingress') as any;
  assert.equal(
    ingress.metadata.annotations['cert-manager.io/cluster-issuer'],
    'test-issuer',
  );
  assert.equal(ingress.spec.tls[0].secretName, 'storefront-tls');
  const solver = objects.find((o) => o.metadata.name === 'acme-http01-solver')!;
  assert.equal(solver.spec.ingress[0].ports[0].port, 8089);
  assert.deepEqual(solver.spec.podSelector.matchLabels, {
    'acme.cert-manager.io/http01-solver': 'true',
  });
  let ready = false;
  const get = f.provisioner.cluster.get.bind(f.provisioner.cluster);
  f.provisioner.cluster.get = async (o) =>
    o.kind === 'Certificate'
      ? {
          status: {
            conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
          },
        }
      : get(o);
  f.state.available = new Set(['mariadb', 'wordpress', 'woo-mcp']);
  f.state.job = 'succeeded';
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Provisioning');
  assert.ok(!f.events.some((e) => e.startsWith('register ')));
  ready = true;
  await f.provisioner.reconcile();
  assert.equal(f.store.status, 'Ready');
  assert.throws(
    () => storeManifests('north', { ...settings, scheme: 'https' }),
    /TLS Secret/,
  );
});
