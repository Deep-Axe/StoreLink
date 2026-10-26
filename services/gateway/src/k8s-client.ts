import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';

export type KubeResponse = { status: number; body: unknown };

// Talks to the Kubernetes API with the pod's ServiceAccount.
export class KubernetesClient {
  directory: string;
  constructor(directory = '/var/run/secrets/kubernetes.io/serviceaccount') {
    this.directory = directory;
  }
  request(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<KubeResponse> {
    const headers: OutgoingHttpHeaders = {
      authorization: `Bearer ${readFileSync(`${this.directory}/token`, 'utf8').trim()}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = contentType;
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: process.env.KUBERNETES_SERVICE_HOST,
          port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? 443),
          path,
          method,
          headers,
          ca: readFileSync(`${this.directory}/ca.crt`),
          timeout: 10000,
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
            if (data.length > 4194304)
              request.destroy(new Error('Kubernetes response exceeds limit'));
          });
          response.on('end', () => {
            let parsed: unknown;
            try {
              parsed = data ? JSON.parse(data) : undefined;
            } catch {
              reject(new Error('Invalid Kubernetes API response'));
              return;
            }
            resolve({ status: response.statusCode ?? 0, body: parsed });
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Kubernetes API request timed out')),
      );
      request.on('error', () =>
        reject(new Error('Kubernetes API is unavailable')),
      );
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}

export const storeNamespacePattern =
  /^storelink-store-[a-z](?:[a-z0-9-]{0,10}[a-z0-9])?$/;
export const managedLabel = 'storelink/managed-store';

type KubeObject = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
};

const resources: Record<string, { base: string; plural: string }> = {
  Namespace: { base: '/api/v1', plural: 'namespaces' },
  ResourceQuota: { base: '/api/v1', plural: 'resourcequotas' },
  LimitRange: { base: '/api/v1', plural: 'limitranges' },
  Secret: { base: '/api/v1', plural: 'secrets' },
  ConfigMap: { base: '/api/v1', plural: 'configmaps' },
  PersistentVolumeClaim: { base: '/api/v1', plural: 'persistentvolumeclaims' },
  Service: { base: '/api/v1', plural: 'services' },
  NetworkPolicy: {
    base: '/apis/networking.k8s.io/v1',
    plural: 'networkpolicies',
  },
  Ingress: { base: '/apis/networking.k8s.io/v1', plural: 'ingresses' },
  Certificate: { base: '/apis/cert-manager.io/v1', plural: 'certificates' },
  Deployment: { base: '/apis/apps/v1', plural: 'deployments' },
  Job: { base: '/apis/batch/v1', plural: 'jobs' },
};

export class KubernetesApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The provisioner's only way into the cluster. RBAC cannot limit a ClusterRole
// to a name pattern, so every operation is checked against the store namespace
// pattern here, and namespaces are deleted only if they carry the managed label.
export class StoreCluster {
  client: Pick<KubernetesClient, 'request'>;
  fieldManager = 'storelink-provisioner';
  constructor(client: Pick<KubernetesClient, 'request'>) {
    this.client = client;
  }
  private namespaceOf(object: KubeObject): string {
    const namespace =
      object.kind === 'Namespace'
        ? object.metadata.name
        : object.metadata.namespace;
    if (!namespace || !storeNamespacePattern.test(namespace))
      throw new Error('Refusing to touch a namespace outside store namespaces');
    return namespace;
  }
  private path(object: KubeObject): string {
    const resource = resources[object.kind];
    if (!resource) throw new Error(`Unsupported kind ${object.kind}`);
    const namespace = this.namespaceOf(object);
    const name = encodeURIComponent(object.metadata.name);
    return object.kind === 'Namespace'
      ? `${resource.base}/namespaces/${name}`
      : `${resource.base}/namespaces/${namespace}/${resource.plural}/${name}`;
  }
  private check(response: KubeResponse, action: string) {
    if (response.status >= 200 && response.status < 300) return response.body;
    const message =
      (response.body as { message?: string } | undefined)?.message ??
      `HTTP ${response.status}`;
    throw new KubernetesApiError(`${action}: ${message}`, response.status);
  }
  // Server-side apply: creates or updates the object to match.
  async apply(object: KubeObject): Promise<unknown> {
    const response = await this.client.request(
      'PATCH',
      `${this.path(object)}?fieldManager=${this.fieldManager}&force=true`,
      object,
      'application/apply-patch+yaml',
    );
    return this.check(response, `Apply ${object.kind} ${object.metadata.name}`);
  }
  // Creates the object only if it does not exist; never overwrites it.
  // Returns false when it already existed.
  async create(object: KubeObject): Promise<boolean> {
    const resource = resources[object.kind];
    const namespace = this.namespaceOf(object);
    const response = await this.client.request(
      'POST',
      `${resource.base}/namespaces/${namespace}/${resource.plural}`,
      object,
    );
    if (response.status === 409) return false;
    this.check(response, `Create ${object.kind} ${object.metadata.name}`);
    return true;
  }
  async get(object: KubeObject): Promise<unknown | undefined> {
    const response = await this.client.request('GET', this.path(object));
    if (response.status === 404) return undefined;
    return this.check(response, `Read ${object.kind} ${object.metadata.name}`);
  }
  async deleteNamespace(name: string): Promise<'deleting' | 'gone'> {
    const object = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name },
    };
    const found = (await this.get(object)) as KubeObject | undefined;
    if (!found) return 'gone';
    if (found.metadata.labels?.[managedLabel] !== 'true')
      throw new Error(
        'Refusing to delete a namespace StoreLink does not manage',
      );
    const response = await this.client.request('DELETE', this.path(object));
    if (response.status === 404) return 'gone';
    this.check(response, `Delete namespace ${name}`);
    return 'deleting';
  }
}
