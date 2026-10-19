import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type User = {
  userId: string;
  teamId: string;
  role: 'admin' | 'member';
  email: string;
};
type Me = {
  user: User;
  csrf: string;
  chatConfigured: boolean;
  model: string;
  gatewayUrl: string;
};
type Server = {
  id: string;
  slug: string;
  url?: string;
  enabled: boolean;
  hasCredential?: boolean;
  status: string;
  tools: string[];
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
};
type Member = {
  id: string;
  email: string;
  role: string;
  disabled_at: string | null;
};
type Key = {
  id: string;
  user_id: string;
  label: string;
  email: string;
  created_at: string;
  revoked_at: string | null;
};
type Audit = {
  sequence: string;
  id: string;
  email: string;
  user_id: string;
  server_id: string;
  tool_name: string;
  requested_name: string;
  timestamp: string;
  duration_ms: number;
  outcome: string;
  reason: string;
};
type Activity = {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  result: string;
};
type Message = { role: string; text: string; activity?: Activity[] };
type ServerEvent = {
  sequence: string;
  server_id: string;
  status: string;
  timestamp: string;
};
type Conversation = {
  id: string;
  title: string;
  input_tokens: string;
  output_tokens: string;
};
let csrf = '';
async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—';
const fields = (event: React.FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return new FormData(event.currentTarget);
};
const value = (data: FormData, name: string) => String(data.get(name) ?? '');
function Brand() {
  return (
    <a className="brand" href="/" aria-label="StoreLink home">
      <span className="mark">s</span>
      <span>
        StoreLink<span className="brand-dot">.</span>
      </span>
    </a>
  );
}
function App() {
  const [me, setMe] = useState<Me | null>(null),
    [loading, setLoading] = useState(true),
    [tab, setTab] = useState('Chat'),
    [error, setError] = useState('');
  const [invite] = useState(
    new URLSearchParams(location.hash.slice(1)).get('invite'),
  );
  async function refresh() {
    const result = await api<Me>('/me');
    csrf = result.csrf;
    setMe(result);
  }
  useEffect(() => {
    void refresh()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  async function run(work: () => Promise<void>) {
    setError('');
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed');
    }
  }
  if (loading) return <div className="loading">Opening your workspace…</div>;
  if (!me)
    return (
      <div className="login">
        <section className="login-story">
          <Brand />
          <div>
            <p className="eyebrow">YOUR STORE. ONE WORKSPACE.</p>
            <h1>
              A connected team,
              <br />a calmer day.
            </h1>
            <p>
              Manage your store, connect your tools, and get things done
              together.
            </p>
          </div>
          <small>StoreLink · Commerce & connections</small>
        </section>
        <main className="login-form">
          <div>
            <p className="eyebrow">TEAM WORKSPACE</p>
            <h2>{invite ? 'Join your team' : 'Welcome back'}</h2>
            <p className="muted">
              {invite
                ? 'Choose a password to accept your invitation.'
                : 'Sign in to your StoreLink workspace.'}
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(event) => {
                const data = fields(event);
                void run(async () => {
                  if (invite) {
                    await api('/accept-invite', {
                      token: invite,
                      password: value(data, 'password'),
                    });
                    location.hash = '';
                    location.reload();
                  } else {
                    const result = await api<{ csrf: string }>('/login', {
                      email: value(data, 'email'),
                      password: value(data, 'password'),
                    });
                    csrf = result.csrf;
                    await refresh();
                  }
                });
              }}
            >
              {!invite && (
                <label>
                  Email address
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    placeholder="you@company.com"
                  />
                </label>
              )}
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  autoComplete={invite ? 'new-password' : 'current-password'}
                  minLength={invite ? 12 : 1}
                  maxLength={128}
                  required
                />
              </label>
              <button className="primary" type="submit">
                {invite ? 'Accept invitation' : 'Sign in'}{' '}
                <span aria-hidden="true">↗</span>
              </button>
            </form>
            {invite && (
              <p className="muted">
                Use at least 12 characters. Invitations expire after 24 hours.
              </p>
            )}
          </div>
        </main>
      </div>
    );
  return (
    <div className="workspace">
      <aside>
        <Brand />
        <div className="team">
          <span className="avatar">
            {me.user.teamId.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{me.user.teamId}</strong>
            <small>Team workspace</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {['Chat', 'Connections', 'Access', 'Activity'].map((name) => (
            <button
              key={name}
              onClick={() => {
                setTab(name);
                setError('');
              }}
              className={tab === name ? 'selected' : ''}
            >
              <span aria-hidden="true" className="nav-icon">
                {
                  { Chat: '✧', Connections: '⊞', Access: '♙', Activity: '≋' }[
                    name
                  ]
                }
              </span>
              {name}
            </button>
          ))}
        </nav>
        <div className="aside-footer">
          <span className="avatar">
            {me.user.email.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{me.user.email}</strong>
            <small>{me.user.role}</small>
          </div>
          <button
            className="icon-button"
            title="Sign out"
            aria-label="Sign out"
            onClick={() =>
              void run(async () => {
                await api('/logout', {});
                csrf = '';
                setMe(null);
              })
            }
          >
            ↪
          </button>
        </div>
      </aside>
      <div className="main-area">
        <header>
          <span>
            Workspace <span className="muted">/ {tab}</span>
          </span>
          <span className="pill">● &nbsp; Team connected</span>
        </header>
        <main>
          {error && (
            <div role="alert" className="error">
              {error}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError('')}
              >
                ×
              </button>
            </div>
          )}
          {tab === 'Chat' ? (
            <Chat me={me} run={run} />
          ) : tab === 'Connections' ? (
            <Connections me={me} run={run} />
          ) : tab === 'Access' ? (
            <Access me={me} run={run} />
          ) : (
            <ActivityView run={run} />
          )}
        </main>
        <footer>
          StoreLink workspace <span>Shared tools. Individual access.</span>
        </footer>
      </div>
    </div>
  );
}
type Run = (work: () => Promise<void>) => Promise<void>;
function Title({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {children}
    </div>
  );
}
function Connections({ me, run }: { me: Me; run: Run }) {
  const [servers, setServers] = useState<Server[]>([]),
    [editing, setEditing] = useState<Partial<Server> | null>(null);
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const load = async () => {
    setServers(await api<Server[]>('/servers'));
    setEvents(await api<ServerEvent[]>('/server-events'));
  };
  useEffect(() => {
    void run(load);
    const timer = setInterval(() => void load().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <Title
        eyebrow="CONNECTED TOOLS"
        title="Your connections"
        description="Connect once. Your whole team can use the tools."
      >
        {me.user.role === 'admin' && (
          <button
            className="primary"
            onClick={() => setEditing({ enabled: true })}
          >
            + Add connection
          </button>
        )}
      </Title>
      <div className="stats">
        <div>
          <span>Connections</span>
          <strong>{servers.length.toString().padStart(2, '0')}</strong>
        </div>
        <div>
          <span>Available now</span>
          <strong>
            {servers
              .filter((server) => server.status === 'Connected')
              .length.toString()
              .padStart(2, '0')}
          </strong>
        </div>
        <div>
          <span>Tools available</span>
          <strong>
            {servers
              .reduce((sum, server) => sum + server.tools.length, 0)
              .toString()
              .padStart(2, '0')}
          </strong>
        </div>
      </div>
      <section className="cards">
        {servers.map((server) => (
          <article className="card connection" key={server.id}>
            <div className="card-heading">
              <div className="server-icon">
                {server.slug.slice(0, 1).toUpperCase()}
              </div>
              <span className={`badge ${server.status.toLowerCase()}`}>
                {server.status}
              </span>
            </div>
            <h2>{server.slug}</h2>
            {server.url && <p className="endpoint">{server.url}</p>}
            <p className="muted">
              {server.tools.length} tools available
              {server.hasCredential ? ' · Credential configured' : ''}
            </p>
            <div className="tools">
              {server.tools.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </div>
            <dl>
              <div>
                <dt>Last connected</dt>
                <dd>{date(server.lastSuccessAt)}</dd>
              </div>
              {server.lastFailureAt && (
                <div>
                  <dt>Last failure</dt>
                  <dd>
                    {date(server.lastFailureAt)} · {server.lastError}
                  </dd>
                </div>
              )}
            </dl>
            {me.user.role === 'admin' && (
              <div className="actions">
                <button onClick={() => setEditing(server)}>Edit</button>
                <button
                  onClick={() =>
                    void run(async () => {
                      await api('/servers', {
                        id: server.id,
                        slug: server.slug,
                        url: server.url,
                        enabled: !server.enabled,
                      });
                      await load();
                    })
                  }
                >
                  {server.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="danger-link"
                  onClick={() => {
                    if (
                      confirm(`Remove ${server.slug} and its team connection?`)
                    )
                      void run(async () => {
                        await api(`/servers/${server.id}`, undefined, 'DELETE');
                        await load();
                      });
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
      {events.length > 0 && (
        <section className="card connection-history">
          <h2>Connection history</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Connection</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 12).map((event) => (
                  <tr key={event.sequence}>
                    <td>{date(event.timestamp)}</td>
                    <td>
                      {servers.find((server) => server.id === event.server_id)
                        ?.slug ?? event.server_id}
                    </td>
                    <td>
                      <span className={`badge ${event.status.toLowerCase()}`}>
                        {event.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-title"
          >
            <div className="card-heading">
              <h2 id="connection-title">
                {editing.id ? 'Edit connection' : 'Add a connection'}
              </h2>
              <button
                className="icon-button"
                aria-label="Close"
                onClick={() => setEditing(null)}
              >
                ×
              </button>
            </div>
            <form
              onSubmit={(event) => {
                const data = fields(event);
                void run(async () => {
                  const secret = value(data, 'credential');
                  const credential = data.get('clear')
                    ? null
                    : secret
                      ? { header: value(data, 'header'), value: secret }
                      : undefined;
                  await api('/servers', {
                    id: editing.id,
                    slug: value(data, 'slug'),
                    url: value(data, 'url'),
                    enabled: Boolean(data.get('enabled')),
                    credential,
                  });
                  setEditing(null);
                  await load();
                });
              }}
            >
              <label>
                Name
                <input
                  name="slug"
                  defaultValue={editing.slug}
                  required
                  pattern="[a-z][a-z0-9_-]{0,15}"
                  maxLength={16}
                  placeholder="inventory"
                />
              </label>
              <label>
                Server URL
                <input
                  name="url"
                  defaultValue={editing.url}
                  type="url"
                  required
                  placeholder="https://tools.example.com/mcp"
                />
              </label>
              <label>
                Credential header
                <input name="header" defaultValue="Authorization" />
              </label>
              <label>
                Credential value
                <input
                  name="credential"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    editing.hasCredential
                      ? 'Leave blank to keep existing credential'
                      : 'Optional, e.g. Bearer …'
                  }
                />
              </label>
              {editing.hasCredential && (
                <label className="checkbox">
                  <input name="clear" type="checkbox" />
                  Remove existing credential
                </label>
              )}
              <label className="checkbox">
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={editing.enabled}
                />
                Enabled for the team
              </label>
              <p className="muted">
                Credentials stay on the server. The deployment must allow the
                server’s origin.
              </p>
              <button className="primary">Save connection</button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
function Access({ me, run }: { me: Me; run: Run }) {
  const [keys, setKeys] = useState<Key[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [revealed, setRevealed] = useState(''),
    [invitation, setInvitation] = useState('');
  const load = async () => {
    setKeys(await api<Key[]>('/keys'));
    if (me.user.role === 'admin') setMembers(await api<Member[]>('/members'));
  };
  useEffect(() => {
    void run(load);
  }, []);
  return (
    <>
      <Title
        eyebrow="TEAM & ACCESS"
        title="One endpoint, your own key"
        description="Connect your MCP client and manage access to the workspace."
      />
      <section className="card endpoint-card">
        <p className="eyebrow">YOUR MCP ENDPOINT</p>
        <code>{me.gatewayUrl}</code>
        <p className="muted">
          Use Streamable HTTP with an Authorization: Bearer &lt;your key&gt;
          header. Refresh the tool list after connections change.
        </p>
      </section>
      {revealed && (
        <section className="notice" role="status">
          <strong>Save your new key. It is shown only once.</strong>
          <code>{revealed}</code>
          <button onClick={() => setRevealed('')}>I’ve saved it</button>
        </section>
      )}
      <section className="card">
        <h2>API keys</h2>
        <form
          className="inline-form"
          onSubmit={(event) => {
            const data = fields(event);
            void run(async () => {
              const result = await api<{ key: string }>('/keys', {
                label: value(data, 'label'),
                userId: value(data, 'userId') || undefined,
              });
              setRevealed(result.key);
              await load();
            });
          }}
        >
          <label>
            Key name
            <input
              name="label"
              required
              maxLength={80}
              placeholder="My desktop client"
            />
          </label>
          {me.user.role === 'admin' && (
            <label>
              Owner
              <select name="userId">
                {members
                  .filter((member) => !member.disabled_at)
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.email}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <button className="primary">Generate key</button>
        </form>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Created</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.label}</td>
                  <td>{key.email}</td>
                  <td>{date(key.created_at)}</td>
                  <td>
                    <span
                      className={`badge ${key.revoked_at ? 'disabled' : 'connected'}`}
                    >
                      {key.revoked_at ? 'Revoked' : 'Active'}
                    </span>
                  </td>
                  <td>
                    {!key.revoked_at && (
                      <button
                        className="danger-link"
                        onClick={() =>
                          void run(async () => {
                            await api(`/keys/${key.id}`, undefined, 'DELETE');
                            await load();
                          })
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {me.user.role === 'admin' && (
        <section className="card">
          <h2>Team members</h2>
          <form
            className="inline-form"
            onSubmit={(event) => {
              const data = fields(event);
              void run(async () => {
                const result = await api<{ url: string }>('/invitations', {
                  email: value(data, 'email'),
                });
                setInvitation(result.url);
              });
            }}
          >
            <label>
              Email address
              <input
                name="email"
                type="email"
                required
                placeholder="teammate@company.com"
              />
            </label>
            <button>Invite member</button>
          </form>
          {invitation && (
            <div className="notice">
              <strong>
                Share this invitation privately. It expires in 24 hours.
              </strong>
              <code>{invitation}</code>
              <button onClick={() => setInvitation('')}>Dismiss</button>
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.email}</td>
                    <td>{member.role}</td>
                    <td>{member.disabled_at ? 'Removed' : 'Active'}</td>
                    <td>
                      {member.role === 'member' && !member.disabled_at && (
                        <button
                          className="danger-link"
                          onClick={() => {
                            if (
                              confirm(
                                `Remove ${member.email} and end their access?`,
                              )
                            )
                              void run(async () => {
                                await api(
                                  `/members/${member.id}`,
                                  undefined,
                                  'DELETE',
                                );
                                await load();
                              });
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
function ActivityView({ run }: { run: Run }) {
  const [rows, setRows] = useState<Audit[]>([]);
  useEffect(() => {
    void run(async () => setRows(await api<Audit[]>('/audit')));
  }, []);
  return (
    <>
      <Title
        eyebrow="WORKSPACE HISTORY"
        title="Every action, accounted for"
        description="Tool calls from chat and external clients, attributed to the person who made them."
      >
        <button
          onClick={() =>
            void run(async () => setRows(await api<Audit[]>('/audit')))
          }
        >
          Refresh
        </button>
      </Title>
      <section className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Tool</th>
                <th>Duration</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{date(row.timestamp)}</td>
                  <td>{row.email || row.user_id || 'Unknown caller'}</td>
                  <td>
                    <strong>{row.server_id || '—'}</strong>
                    <br />
                    <code>{row.tool_name || row.requested_name}</code>
                  </td>
                  <td>{row.duration_ms} ms</td>
                  <td>
                    <span
                      className={`badge ${row.outcome === 'success' ? 'connected' : row.outcome === 'started' ? 'disabled' : 'unreachable'}`}
                    >
                      {row.outcome}
                    </span>
                    {row.reason && <small>{row.reason}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="empty">
              Tool calls will appear here as your team uses the workspace.
            </p>
          )}
        </div>
        {rows.length >= 50 && (
          <button
            onClick={() =>
              void run(async () => {
                const next = await api<Audit[]>(
                  `/audit?before=${rows.at(-1)?.sequence}`,
                );
                setRows([...rows, ...next]);
              })
            }
          >
            Load older activity
          </button>
        )}
      </section>
    </>
  );
}
function Chat({ me, run }: { me: Me; run: Run }) {
  const [messages, setMessages] = useState<Message[]>([]),
    [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [id, setId] = useState<string>(),
    [history, setHistory] = useState<Conversation[]>([]);
  const load = async () =>
    setHistory(await api<Conversation[]>('/conversations'));
  useEffect(() => {
    void run(load);
  }, []);
  async function send(message: string) {
    if (!message.trim() || busy) return;
    setDraft('');
    setMessages((previous) => [...previous, { role: 'user', text: message }]);
    setBusy(true);
    try {
      await run(async () => {
        const result = await api<{
          id: string;
          text: string;
          activity: Activity[];
        }>('/chat', { conversationId: id, message });
        setId(result.id);
        setMessages((previous) => [
          ...previous,
          { role: 'assistant', text: result.text, activity: result.activity },
        ]);
        await load();
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title
        eyebrow="YOUR STORE ASSISTANT"
        title="What’s on your mind?"
        description="Ask a question. Take an action. Keep your team moving."
      >
        <button
          disabled={busy}
          onClick={() => {
            setId(undefined);
            setMessages([]);
          }}
        >
          + New conversation
        </button>
      </Title>
      <div className="chat-layout">
        <section className="card chat-card">
          <div className="messages" aria-live="polite">
            {!messages.length && (
              <div className="chat-welcome">
                <div className="assistant-mark">✧</div>
                <h2>A little help for your day.</h2>
                <p className="muted">
                  Work with your store and connected tools in one conversation.
                </p>
                <div className="suggestions">
                  {[
                    'What orders came in today?',
                    'What is our fulfillment policy?',
                    'Show me the products in our store.',
                  ].map((prompt) => (
                    <button
                      disabled={!me.chatConfigured || busy}
                      key={prompt}
                      onClick={() => void send(prompt)}
                    >
                      {prompt}
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, index) => (
              <article className={`message ${message.role}`} key={index}>
                <span className="eyebrow">
                  {message.role === 'user' ? 'YOU' : 'STORELINK'}
                </span>
                <p>{message.text}</p>
                {message.activity?.map((activity, index) => (
                  <details className="tool-activity" key={index}>
                    <summary>
                      {activity.isError ? '!' : '✓'} {activity.name}
                    </summary>
                    <pre>{JSON.stringify(activity.arguments, null, 2)}</pre>
                    <pre>{activity.result}</pre>
                  </details>
                ))}
              </article>
            ))}
            {busy && <p className="thinking">✧ Working with your tools…</p>}
          </div>
          {!me.chatConfigured && (
            <div className="notice">
              Chat is waiting for an OpenAI API key from the workspace operator.
              Connections and external clients are ready to use.
            </div>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <label className="sr-only" htmlFor="chat-message">
              Message
            </label>
            <textarea
              id="chat-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about your store…"
              maxLength={8000}
              disabled={!me.chatConfigured || busy}
              rows={2}
            />
            <button
              className="primary"
              disabled={!me.chatConfigured || busy || !draft.trim()}
              aria-label="Send message"
            >
              ↑
            </button>
          </form>
          <small className="chat-note">
            Review store changes before repeating them. Your tool calls appear
            in Activity.
          </small>
        </section>
        <section className="conversation-list">
          <p className="eyebrow">RECENT CONVERSATIONS</p>
          {history.map((conversation) => (
            <button
              key={conversation.id}
              disabled={busy}
              className={id === conversation.id ? 'active-conversation' : ''}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ messages: unknown[] }>(
                    `/conversations/${conversation.id}`,
                  );
                  const parsed: Message[] = [];
                  for (const item of result.messages) {
                    const entry = item as { role?: string; content?: unknown };
                    if (
                      entry.role &&
                      ['user', 'assistant'].includes(entry.role)
                    ) {
                      const text =
                        typeof entry.content === 'string'
                          ? entry.content
                          : Array.isArray(entry.content)
                            ? entry.content
                                .map(
                                  (part) =>
                                    (part as { text?: string }).text ?? '',
                                )
                                .join('')
                            : '';
                      if (text) parsed.push({ role: entry.role, text });
                    }
                  }
                  setMessages(parsed);
                  setId(conversation.id);
                })
              }
            >
              <span>{conversation.title}</span>
              <small>
                {Number(conversation.input_tokens) +
                  Number(conversation.output_tokens)}{' '}
                tokens
              </small>
            </button>
          ))}
          {!history.length && (
            <p className="muted">Your conversations will be saved here.</p>
          )}
        </section>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
