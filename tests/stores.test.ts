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
