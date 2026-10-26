import { createHash, randomBytes } from 'node:crypto';
import { managedLabel, storeNamespacePattern } from './k8s-client.ts';

export const storeSlugPattern = /^[a-z][a-z0-9-]{0,11}$/;

type Resources = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};
export type StoreSettings = {
  images: { app: string; store: string; mariadb: string; pullPolicy: string };
  // Storefront hosts are <slug>.<hostSuffix>.
  hostSuffix: string;
  scheme: 'http' | 'https';
  tlsSecretName?: string;
  tlsClusterIssuer?: string;
  quota?: Record<string, string>;
  ingressClass: string;
  storageClass: string;
  storage: { wordpress: string; mariadb: string };
  timezone: string;
  woocommerceVersion: string;
  // Where the gateway runs, so only it can reach each store's MCP server.
  gateway: { namespace: string; instance: string };
  healthPhp: string;
  resources: { wordpress: Resources; mariadb: Resources; wooMcp: Resources };
};

// Every name and address a store uses comes from here, so the Ingress host,
// WordPress URLs, OAuth signing and the MCP origin always agree.
export function storeNames(
  slug: string,
  settings: Pick<StoreSettings, 'hostSuffix' | 'scheme'>,
) {
  if (!storeSlugPattern.test(slug)) throw new Error('Invalid store slug');
  const namespace = `storelink-store-${slug}`;
  if (!storeNamespacePattern.test(namespace))
    throw new Error('Invalid store namespace');
  const host = `${slug}.${settings.hostSuffix}`;
  const mcpOrigin = `http://woo-mcp.${namespace}.svc.cluster.local:3001`;
  return {
    namespace,
    host,
    publicUrl: `${settings.scheme}://${host}`,
    mcpOrigin,
    mcpUrl: `${mcpOrigin}/mcp`,
    upstreamSlug: `woo-${slug}`,
  };
}

// Generated once per store; the provisioner creates it only if it is missing,
// since MariaDB and WooCommerce keep the first values they see.
export function storeSecret(
  slug: string,
  settings: StoreSettings,
  mcpToken?: string,
) {
  const { namespace } = storeNames(slug, settings);
  const random = () => randomBytes(32).toString('base64url');
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'store-credentials', namespace, labels: labels(slug) },
    type: 'Opaque',
    stringData: {
      'mariadb-root-password': random(),
      'wordpress-db-password': random(),
      'wordpress-admin-password': random(),
      'woo-consumer-key': `ck_${randomBytes(20).toString('hex')}`,
      'woo-consumer-secret': `cs_${randomBytes(20).toString('hex')}`,
      'woo-mcp-token': mcpToken ?? random(),
    },
  };
}

function labels(slug: string, component?: string) {
  return {
    'app.kubernetes.io/managed-by': 'storelink-provisioner',
    'storelink/store': slug,
    ...(component && { 'storelink/component': component }),
  };
}
const selector = (slug: string, component: string) => ({
  matchLabels: { 'storelink/store': slug, 'storelink/component': component },
});
const secretEnv = (name: string, key: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: 'store-credentials', key } },
});
const dropAll = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
};
const nonRoot = (id: number) => ({
  runAsNonRoot: true,
  runAsUser: id,
  runAsGroup: id,
  fsGroup: id,
  fsGroupChangePolicy: 'OnRootMismatch',
});

export function storeManifests(
  slug: string,
  settings: StoreSettings,
  title = 'StoreLink Store',
  attempt = 1,
) {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error('Invalid provisioning attempt');
  if (settings.scheme === 'https' && !settings.tlsSecretName)
    throw new Error('HTTPS stores need a TLS Secret name');
  const names = storeNames(slug, settings);
  const { namespace } = names;
  const meta = (name: string, component?: string) => ({
    name,
    namespace,
    labels: labels(slug, component),
  });
  const deployment = (
    name: string,
    podSpec: Record<string, unknown>,
    component = name,
  ) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(name, component),
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: selector(slug, component),
      template: {
        metadata: { labels: labels(slug, component) },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...podSpec,
        },
      },
    },
  });
  const service = (
    name: string,
    port: number,
    targetPort: string | number,
  ) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(name, name),
    spec: {
      selector: selector(slug, name).matchLabels,
      ports: [{ port, targetPort }],
    },
  });
  const claim = (name: string, size: string) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: meta(name, name),
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: settings.storageClass,
      resources: { requests: { storage: size } },
    },
  });
  const policy = (
    name: string,
    component: string | undefined,
    spec: Record<string, unknown>,
  ) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: meta(name),
    spec: {
      podSelector: component ? selector(slug, component) : {},
      ...spec,
    },
  });
  const from = (component: string) => ({
    podSelector: selector(slug, component),
  });
  const traefik = {
    namespaceSelector: {
      matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
    },
    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } },
  };
  const gateway = {
    namespaceSelector: {
      matchLabels: {
        'kubernetes.io/metadata.name': settings.gateway.namespace,
      },
    },
    podSelector: {
      matchLabels: {
        'storelink/component': 'gateway',
        'app.kubernetes.io/instance': settings.gateway.instance,
      },
    },
  };
  const tcp = (port: number) => [{ protocol: 'TCP', port }];
  const wordpressEnv = [
    { name: 'WORDPRESS_DB_HOST', value: 'mariadb' },
    { name: 'WORDPRESS_DB_NAME', value: 'wordpress' },
    { name: 'WORDPRESS_DB_USER', value: 'wordpress' },
    secretEnv('WORDPRESS_DB_PASSWORD', 'wordpress-db-password'),
    { name: 'STORE_PUBLIC_URL', value: names.publicUrl },
  ];
  const bootstrap = {
    restartPolicy: 'OnFailure',
    automountServiceAccountToken: false,
    // Service variables such as WOO_MCP_PORT would override the app's own settings.
    enableServiceLinks: false,
    securityContext: nonRoot(33),
    affinity: {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: selector(slug, 'wordpress'),
            topologyKey: 'kubernetes.io/hostname',
          },
        ],
      },
    },
    containers: [
      {
        name: 'bootstrap',
        image: settings.images.store,
        imagePullPolicy: settings.images.pullPolicy,
        command: ['bash', '/opt/storelink/bootstrap.sh'],
        env: [
          ...wordpressEnv,
          { name: 'STORE_TITLE', value: title },
          { name: 'STORE_TIMEZONE', value: settings.timezone },
          { name: 'WOOCOMMERCE_VERSION', value: settings.woocommerceVersion },
          { name: 'WORDPRESS_ADMIN_USER', value: 'admin' },
          secretEnv('WORDPRESS_ADMIN_PASSWORD', 'wordpress-admin-password'),
          secretEnv('WOO_CONSUMER_KEY', 'woo-consumer-key'),
          secretEnv('WOO_CONSUMER_SECRET', 'woo-consumer-secret'),
        ],
        resources: {
          requests: { cpu: '100m', memory: '192Mi' },
          limits: { cpu: '1', memory: '512Mi' },
        },
        securityContext: dropAll,
        volumeMounts: [
          { name: 'wordpress', mountPath: '/var/www/html' },
          { name: 'tmp', mountPath: '/tmp' },
        ],
      },
    ],
    volumes: [
      { name: 'wordpress', persistentVolumeClaim: { claimName: 'wordpress' } },
      { name: 'tmp', emptyDir: {} },
    ],
  };
  // Jobs cannot be changed after creation, so the name follows the spec.
  const jobName = `store-bootstrap-${createHash('sha256')
    .update(JSON.stringify(bootstrap))
    .digest('hex')
    .slice(0, 10)}-${attempt}`;
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      ...meta('wordpress', 'wordpress'),
      ...(settings.tlsClusterIssuer && {
        annotations: {
          'cert-manager.io/cluster-issuer': settings.tlsClusterIssuer,
        },
      }),
    },
    spec: {
      ingressClassName: settings.ingressClass,
      ...(settings.tlsSecretName && {
        tls: [{ hosts: [names.host], secretName: settings.tlsSecretName }],
      }),
      rules: [
        {
          host: names.host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'wordpress', port: { number: 80 } },
                },
              },
            ],
          },
        },
      ],
    },
  };
  return {
    names,
    jobName,
    objects: [
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: namespace,
          labels: { ...labels(slug), [managedLabel]: 'true' },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'ResourceQuota',
        metadata: meta('store'),
        spec: {
          hard: {
            'requests.cpu': '1',
            'requests.memory': '1Gi',
            'limits.cpu': '6',
            'limits.memory': '2Gi',
            pods: '6',
            persistentvolumeclaims: '2',
            'requests.storage': '8Gi',
            services: '4',
            ...settings.quota,
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'LimitRange',
        metadata: meta('store'),
        spec: {
          limits: [
            {
              type: 'Container',
              defaultRequest: { cpu: '50m', memory: '64Mi' },
              default: { cpu: '500m', memory: '256Mi' },
              max: { cpu: '2', memory: '1Gi' },
            },
          ],
        },
      },
      policy('default-deny', undefined, { policyTypes: ['Ingress', 'Egress'] }),
      // HTTP-01 solver pods are created by cert-manager, outside the store's
      // application labels. Let Traefik reach only their challenge port.
      ...(settings.tlsClusterIssuer
        ? [
            {
              apiVersion: 'networking.k8s.io/v1',
              kind: 'NetworkPolicy',
              metadata: meta('acme-http01-solver'),
              spec: {
                podSelector: {
                  matchLabels: { 'acme.cert-manager.io/http01-solver': 'true' },
                },
                policyTypes: ['Ingress'],
                ingress: [{ from: [traefik], ports: tcp(8089) }],
              },
            },
          ]
        : []),
      policy('dns', undefined, {
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      }),
      policy('woo-mcp', 'woo-mcp', {
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [gateway], ports: tcp(3001) }],
        egress: [{ to: [from('wordpress')], ports: tcp(8080) }],
      }),
      policy('wordpress', 'wordpress', {
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [from('woo-mcp'), traefik], ports: tcp(8080) }],
        egress: [{ to: [from('mariadb')], ports: tcp(3306) }],
      }),
      policy('mariadb', 'mariadb', {
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [from('wordpress'), from('store-bootstrap')],
            ports: tcp(3306),
          },
        ],
      }),
      policy('store-bootstrap', 'store-bootstrap', {
        policyTypes: ['Egress'],
        egress: [{ to: [from('mariadb')], ports: tcp(3306) }],
      }),
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: meta('store-health'),
        data: { 'health.php': settings.healthPhp },
      },
      claim('mariadb', settings.storage.mariadb),
      claim('wordpress', settings.storage.wordpress),
      deployment('mariadb', {
        securityContext: nonRoot(999),
        containers: [
          {
            name: 'mariadb',
            image: settings.images.mariadb,
            imagePullPolicy: settings.images.pullPolicy,
            args: ['--innodb-buffer-pool-size=64M', '--max-connections=30'],
            env: [
              { name: 'MARIADB_DATABASE', value: 'wordpress' },
              { name: 'MARIADB_USER', value: 'wordpress' },
              secretEnv('MARIADB_PASSWORD', 'wordpress-db-password'),
              secretEnv('MARIADB_ROOT_PASSWORD', 'mariadb-root-password'),
            ],
            ports: [{ containerPort: 3306, name: 'mysql' }],
            startupProbe: {
              exec: {
                command: [
                  'healthcheck.sh',
                  '--connect',
                  '--innodb_initialized',
                ],
              },
              periodSeconds: 2,
              failureThreshold: 60,
            },
            readinessProbe: {
              exec: {
                command: [
                  'healthcheck.sh',
                  '--connect',
                  '--innodb_initialized',
                ],
              },
              periodSeconds: 5,
            },
            livenessProbe: {
              exec: { command: ['healthcheck.sh', '--connect'] },
              periodSeconds: 10,
              failureThreshold: 6,
            },
            securityContext: dropAll,
            resources: settings.resources.mariadb,
            volumeMounts: [{ name: 'data', mountPath: '/var/lib/mysql' }],
          },
        ],
        volumes: [
          { name: 'data', persistentVolumeClaim: { claimName: 'mariadb' } },
        ],
      }),
      service('mariadb', 3306, 'mysql'),
      deployment('wordpress', {
        securityContext: nonRoot(33),
        containers: [
          {
            name: 'wordpress',
            image: settings.images.store,
            imagePullPolicy: settings.images.pullPolicy,
            env: [
              ...wordpressEnv,
              {
                name: 'WORDPRESS_CONFIG_EXTRA',
                value: [
                  "define('WP_HOME', getenv('STORE_PUBLIC_URL'));",
                  "define('WP_SITEURL', getenv('STORE_PUBLIC_URL'));",
                  "define('DISALLOW_FILE_EDIT', true);",
                  "define('WP_MEMORY_LIMIT', '256M');",
                ].join('\n'),
              },
            ],
            ports: [{ containerPort: 8080, name: 'http' }],
            startupProbe: {
              tcpSocket: { port: 'http' },
              periodSeconds: 2,
              failureThreshold: 90,
            },
            readinessProbe: {
              httpGet: { path: '/storelink-health.php', port: 'http' },
              periodSeconds: 5,
              timeoutSeconds: 5,
              failureThreshold: 3,
            },
            livenessProbe: {
              tcpSocket: { port: 'http' },
              periodSeconds: 10,
              failureThreshold: 6,
            },
            securityContext: dropAll,
            resources: settings.resources.wordpress,
            volumeMounts: [
              { name: 'wordpress', mountPath: '/var/www/html' },
              {
                name: 'health',
                mountPath: '/var/www/html/storelink-health.php',
                subPath: 'health.php',
                readOnly: true,
              },
            ],
          },
        ],
        volumes: [
          {
            name: 'wordpress',
            persistentVolumeClaim: { claimName: 'wordpress' },
          },
          { name: 'health', configMap: { name: 'store-health' } },
        ],
      }),
      service('wordpress', 80, 'http'),
      ingress,
      {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: meta(jobName, 'store-bootstrap'),
        spec: {
          backoffLimit: 6,
          activeDeadlineSeconds: 600,
          template: {
            metadata: { labels: labels(slug, 'store-bootstrap') },
            spec: bootstrap,
          },
        },
      },
      deployment('woo-mcp', {
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
        },
        containers: [
          {
            name: 'woo-mcp',
            image: settings.images.app,
            imagePullPolicy: settings.images.pullPolicy,
            command: ['node', 'services/woocommerce-mcp/src/main.ts'],
            env: [
              { name: 'WOO_MCP_ORIGIN', value: names.mcpOrigin },
              { name: 'WOO_MCP_PORT', value: '3001' },
              { name: 'STORE_PUBLIC_URL', value: names.publicUrl },
              { name: 'STORE_CONNECT_SERVICE', value: 'wordpress' },
              { name: 'WOO_MCP_TOKEN_FILE', value: '/secrets/woo-mcp-token' },
              {
                name: 'WOO_CONSUMER_KEY_FILE',
                value: '/secrets/woo-consumer-key',
              },
              {
                name: 'WOO_CONSUMER_SECRET_FILE',
                value: '/secrets/woo-consumer-secret',
              },
            ],
            ports: [{ name: 'http', containerPort: 3001 }],
            startupProbe: {
              httpGet: { path: '/health/live', port: 'http' },
              periodSeconds: 2,
              failureThreshold: 60,
            },
            readinessProbe: {
              httpGet: { path: '/health/ready', port: 'http' },
              periodSeconds: 5,
            },
            livenessProbe: {
              httpGet: { path: '/health/live', port: 'http' },
              periodSeconds: 10,
            },
            securityContext: { ...dropAll, readOnlyRootFilesystem: true },
            resources: settings.resources.wooMcp,
            volumeMounts: [
              { name: 'secrets', mountPath: '/secrets', readOnly: true },
            ],
          },
        ],
        volumes: [
          {
            name: 'secrets',
            secret: {
              secretName: 'store-credentials',
              items: [
                'woo-mcp-token',
                'woo-consumer-key',
                'woo-consumer-secret',
              ].map((key) => ({ key, path: key })),
            },
          },
        ],
      }),
      service('woo-mcp', 3001, 'http'),
    ],
  };
}
