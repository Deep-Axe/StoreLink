import React, { useEffect, useState } from 'react';

type Store = {
  id: string;
  slug: string;
  displayName: string;
  publicUrl: string;
  upstreamSlug: string;
  status: 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';
  failureReason: string | null;
  createdAt: string;
  createdBy: string;
  attempt: number;
};
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export function Stores({
  me,
  request,
  run,
}: {
  me: {
    user: { userId: string; role: 'admin' | 'member' };
    storeLimits?: { perUser: number; perTeam: number };
  };
  request: Request;
  run: (work: () => Promise<void>) => Promise<void>;
}) {
  const [stores, setStores] = useState<Store[]>([]),
    [loading, setLoading] = useState(true),
    [refreshError, setRefreshError] = useState(''),
    [creating, setCreating] = useState(false),
    [deleting, setDeleting] = useState<Store | null>(null),
    [busy, setBusy] = useState(false);
  async function load() {
    const rows = await request<Store[]>('/stores');
    setStores(rows);
    setRefreshError('');
    setLoading(false);
  }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const rows = await request<Store[]>('/stores');
        if (!stopped) {
          setStores(rows);
          setRefreshError('');
        }
      } catch {
        if (!stopped)
          setRefreshError(
            'Store status could not be refreshed. The last available status is shown.',
          );
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [request]);
  async function action(work: () => Promise<void>) {
    if (busy) return;
    await run(async () => {
      setBusy(true);
      try {
        await work();
        await load();
      } finally {
        setBusy(false);
      }
    });
  }
  const owned = stores.filter(
    (store) => store.createdBy === me.user.userId,
  ).length;
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">YOUR STOREFRONTS</p>
          <h1>Your stores</h1>
          <p className="muted">
            Create a store and its tools become available to your team
            automatically.
          </p>
        </div>
        <button
          className="primary"
          disabled={
            busy || (me.storeLimits ? owned >= me.storeLimits.perUser : false)
          }
          onClick={() => setCreating(true)}
        >
          + Create store
        </button>
      </div>
      {me.storeLimits && (
        <p className="muted">
          {owned} of {me.storeLimits.perUser} personal stores used ·{' '}
          {me.storeLimits.perTeam} stores per team. Deleting stores count until
          removal finishes.
        </p>
      )}
      {refreshError && (
        <div role="alert" className="error">
          {refreshError}
          <button onClick={() => void run(load)}>Refresh</button>
        </div>
      )}
      {loading ? (
        <p role="status">Loading stores…</p>
      ) : !stores.length ? (
        <section className="card">
          <h2>Your first store starts here.</h2>
          <p className="muted">
            Choose a name and address. Once ready, open its storefront or use
            its products and orders in Chat.
          </p>
        </section>
      ) : (
        <section className="cards" aria-label="Stores">
          {stores.map((store) => (
            <article
              className="card connection"
              key={store.id}
              aria-label={store.displayName}
            >
              <div className="card-heading">
                <div className="server-icon">
                  {store.displayName.slice(0, 1).toUpperCase()}
                </div>
                <span
                  className={`badge ${store.status.toLowerCase()}`}
                  role="status"
                >
                  {store.status}
                </span>
              </div>
              <h2>{store.displayName}</h2>
              <p className="endpoint">{store.publicUrl}</p>
              <p className="muted">
                Created {new Date(store.createdAt).toLocaleString()}
              </p>
              {store.status === 'Ready' && (
                <>
                  <p>
                    Tools: <code>{store.upstreamSlug}__*</code>
                  </p>
                  <a href={store.publicUrl} target="_blank" rel="noreferrer">
                    Open storefront ↗
                  </a>
                </>
              )}
              {store.status === 'Provisioning' && (
                <p className="muted">
                  Setting up your store. This page updates automatically.
                </p>
              )}
              {store.status === 'Deleting' && (
                <p className="muted">
                  Removing the store, its data and its tools.
                </p>
              )}
              {store.failureReason && (
                <p className="store-failure" role="alert">
                  {store.failureReason}
                </p>
              )}
              <div className="card-actions">
                {store.status === 'Failed' && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await request(`/stores/${store.id}/retry`, {});
                      })
                    }
                  >
                    Retry setup
                  </button>
                )}
                {store.status !== 'Deleting' && (
                  <button
                    className="danger-text"
                    disabled={busy}
                    aria-label={`Delete ${store.displayName}`}
                    onClick={() => setDeleting(store)}
                  >
                    Delete store
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      {creating && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create store"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void action(async () => {
                await request('/stores', {
                  displayName: String(data.get('displayName')),
                  slug: String(data.get('slug')),
                });
                setCreating(false);
              });
            }}
          >
            <p className="eyebrow">NEW STOREFRONT</p>
            <h2>Create a store</h2>
            <label>
              Store name
              <input
                name="displayName"
                required
                maxLength={60}
                placeholder="North shop"
                autoFocus
              />
            </label>
            <label>
              Store address
              <input
                name="slug"
                required
                maxLength={12}
                pattern="[a-z]([a-z0-9-]{0,10}[a-z0-9])?"
                title="1–12 lowercase letters, digits or hyphens; start with a letter and end with a letter or digit"
                placeholder="north"
              />
            </label>
            <p className="muted">
              Use a unique short address, such as north-shop. Your store’s tools
              will be shared with your team.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create store'}
              </button>
            </div>
          </form>
        </div>
      )}
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Delete store"
          >
            <h2>Delete {deleting.displayName}?</h2>
            <p>
              This permanently removes this store, its products, orders and
              files. Its tools will be removed from your team’s gateway.
            </p>
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="primary danger-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request(
                      `/stores/${deleting.id}`,
                      undefined,
                      'DELETE',
                    );
                    setDeleting(null);
                  })
                }
              >
                {busy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
