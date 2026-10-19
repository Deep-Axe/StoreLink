import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import { z } from 'zod';
import {
  generateApiKey,
  hashApiKey,
} from '../../../packages/shared/src/api-keys.ts';
import type { Identity } from '../../../packages/shared/src/api-keys.ts';
import type { PostgresStore } from './postgres-store.ts';
import type { Registry } from './registry.ts';
import { RegistryInputError } from './registry.ts';
import { CredentialInputError } from './credentials.ts';
import type { Gateway } from './gateway.ts';
import { runChat, ChatInputError, validateChatInput } from './chat.ts';
import type { Model } from './chat.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const email = z
  .string()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const password = z.string().min(12).max(128);
const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;
export const hashPassword = (value: string) => argon2.hash(value, argonOptions);

type Options = {
  store: PostgresStore;
  registry: Registry;
  gateway: Gateway;
  pepper: Uint8Array;
  origin: string;
  model?: Model;
  modelName: string;
};
export function dashboardApi(options: Options) {
  const { store, registry, gateway, pepper, origin } = options;
  const router = express.Router();
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const activeChatUsers = new Set<string>();
  const digest = (kind: string, value: string) =>
    hashApiKey(`${kind}:${value}`, pepper);
  const cookieName =
    new URL(origin).protocol === 'https:' ? '__Host-urumi' : 'urumi';
  const cookieOptions = {
    httpOnly: true,
    secure: new URL(origin).protocol === 'https:',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  };
  const dummyHash = hashPassword(randomBytes(32).toString('base64url'));
  const actor = (res: express.Response) => res.locals.actor as Identity;
  function admin(res: express.Response) {
    if (actor(res).role !== 'admin')
      throw new HttpError(403, 'Administrator access required');
  }
  const equal = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const limiter = (key: string, limit: number, ms: number) => {
    const now = Date.now();
    if (loginAttempts.size >= 10000)
      for (const [entry, value] of loginAttempts)
        if (value.until < now) loginAttempts.delete(entry);
    const value = loginAttempts.get(key);
    if (value && value.until > now) {
      if (++value.count > limit)
        throw new HttpError(429, 'Too many attempts; try again later');
    } else {
      if (loginAttempts.size >= 10000)
        throw new HttpError(429, 'Try again later');
      loginAttempts.set(key, { count: 1, until: now + ms });
    }
  };
  router.use((req, res, next) => {
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin)
    )
      throw new HttpError(403, 'Disallowed host or origin');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin)
      throw new HttpError(403, 'A same-origin request is required');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    next();
  });
  router.use(express.json({ limit: '32kb' }));
  router.post('/login', async (req, res) => {
    limiter(`login-ip:${req.ip}`, 100, 15 * 60 * 1000);
    const input = z
      .object({ email, password: z.string().min(1).max(128) })
      .parse(req.body);
    limiter(`login:${req.ip}:${input.email}`, 15, 15 * 60 * 1000);
    const result = await store.pool.query(
      'SELECT id,password_hash FROM users WHERE email=$1 AND disabled_at IS NULL',
      [input.email],
    );
    const user = result.rows[0];
    const valid = await argon2.verify(
      user?.password_hash ?? (await dummyHash),
      input.password,
    );
    if (!user?.password_hash || !valid)
      throw new HttpError(401, 'Invalid email or password');
    const token = randomBytes(32).toString('base64url');
    await store.pool.query(
      'DELETE FROM sessions WHERE expires_at<now() OR (user_id=$1 AND id IN (SELECT id FROM sessions WHERE user_id=$1 ORDER BY expires_at DESC OFFSET 9))',
      [user.id],
    );
    await store.pool.query(
      `INSERT INTO sessions (id,user_id,digest,expires_at) VALUES ($1,$2,$3,now()+interval '8 hours')`,
      [randomUUID(), user.id, digest('session', token)],
    );
    res
      .cookie(cookieName, token, cookieOptions)
      .json({ csrf: digest('csrf', token) });
  });
  router.post('/accept-invite', async (req, res) => {
    limiter(`invite:${req.ip}`, 10, 15 * 60 * 1000);
    const input = z
      .object({ token: z.string().min(20).max(256), password })
      .parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const client = await store.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE invitations SET accepted_at=now() WHERE digest=$1 AND accepted_at IS NULL AND expires_at>now() RETURNING *',
        [digest('invite', input.token)],
      );
      const invite = result.rows[0];
      if (!invite)
        throw new HttpError(
          400,
          'Invitation is invalid, expired or already used',
        );
      await client.query(
        `INSERT INTO users (id,team_id,role,email,password_hash) VALUES ($1,$2,'member',$3,$4)`,
        [randomUUID(), invite.team_id, invite.email, passwordHash],
      );
      await client.query('COMMIT');
      res.status(201).json({ accepted: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  router.use(async (req, res, next) => {
    const token =
      (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) ?? '';
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token))
      throw new HttpError(401, 'Sign in to continue');
    const result = await store.pool.query(
      `SELECT u.id AS "userId",u.team_id AS "teamId",u.role,u.email,s.id AS "sessionId" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`,
      [digest('session', token)],
    );
    if (!result.rows[0])
      throw new HttpError(401, 'Session expired; sign in again');
    res.locals.actor = { ...result.rows[0], keyId: '' };
    res.locals.csrf = digest('csrf', token);
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !equal(String(req.headers['x-csrf-token'] ?? ''), res.locals.csrf)
    )
      throw new HttpError(403, 'Refresh the page and try again');
    limiter(`api:${result.rows[0].userId}`, 180, 60000);
    next();
  });
  router.get('/me', (_req, res) =>
    res.json({
      user: actor(res),
      csrf: res.locals.csrf,
      chatConfigured: Boolean(options.model),
      model: options.modelName,
      gatewayUrl: `${origin}/mcp`,
    }),
  );
  router.post('/logout', async (_req, res) => {
    await store.pool.query('DELETE FROM sessions WHERE id=$1', [
      actor(res).sessionId,
    ]);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  router.get('/servers', async (_req, res) =>
    res.json(await registry.list(actor(res))),
  );
  router.post('/servers', async (req, res) => {
    admin(res);
    const input = z
      .object({
        id: z.string().max(100).optional(),
        slug: z.string().max(16),
        url: z.string().url().max(2048),
        enabled: z.boolean(),
        credential: z
          .object({ header: z.string().max(64), value: z.string().max(4096) })
          .nullable()
          .optional(),
      })
      .parse(req.body);
    const id = await registry.save(actor(res), input);
    res.status(201).json({ id });
  });
  router.delete('/servers/:id', async (req, res) => {
    admin(res);
    await registry.delete(actor(res), String(req.params.id));
    res.json({ ok: true });
  });
  router.get('/server-events', async (_req, res) => {
    res.json(
      (
        await store.pool.query(
          'SELECT * FROM upstream_events WHERE team_id=$1 ORDER BY sequence DESC LIMIT 100',
          [actor(res).teamId],
        )
      ).rows,
    );
  });
  router.get('/tools', async (_req, res) =>
    res.json(await gateway.listTools(actor(res))),
  );
  router.get('/members', async (_req, res) => {
    admin(res);
    res.json(
      (
        await store.pool.query(
          'SELECT id,email,role,disabled_at FROM users WHERE team_id=$1 ORDER BY id',
          [actor(res).teamId],
        )
      ).rows,
    );
  });
  router.post('/invitations', async (req, res) => {
    admin(res);
    const input = z.object({ email }).parse(req.body);
    const existing = await store.pool.query(
      'SELECT 1 FROM users WHERE email=$1',
      [input.email],
    );
    if (existing.rowCount)
      throw new HttpError(409, 'A user with that email already exists');
    const token = randomBytes(32).toString('base64url');
    await store.pool.query(
      `INSERT INTO invitations (id,team_id,email,digest,expires_at,created_by) VALUES ($1,$2,$3,$4,now()+interval '24 hours',$5)`,
      [
        randomUUID(),
        actor(res).teamId,
        input.email,
        digest('invite', token),
        actor(res).userId,
      ],
    );
    res
      .status(201)
      .json({ url: `${origin}/#invite=${token}`, expiresInHours: 24 });
  });
  router.delete('/members/:id', async (req, res) => {
    admin(res);
    if (req.params.id === actor(res).userId)
      throw new HttpError(400, 'You cannot remove your own account');
    await store.pool.query(
      "UPDATE users SET disabled_at=now() WHERE id=$1 AND team_id=$2 AND role='member'",
      [req.params.id, actor(res).teamId],
    );
    res.json({ ok: true });
  });
  router.get('/keys', async (_req, res) => {
    const user = actor(res);
    res.json(
      (
        await store.pool.query(
          `SELECT k.id,k.user_id,k.label,k.created_at,k.revoked_at,u.email FROM api_keys k JOIN users u ON u.id=k.user_id WHERE u.team_id=$1 AND ($2='admin' OR u.id=$3) ORDER BY k.created_at DESC`,
          [user.teamId, user.role, user.userId],
        )
      ).rows,
    );
  });
  router.post('/keys', async (req, res) => {
    const input = z
      .object({
        userId: z.string().max(100).optional(),
        label: z.string().min(1).max(80),
      })
      .parse(req.body);
    const user = actor(res);
    const owner = input.userId ?? user.userId;
    if (owner !== user.userId) admin(res);
    const found = await store.pool.query(
      'SELECT 1 FROM users WHERE id=$1 AND team_id=$2 AND disabled_at IS NULL',
      [owner, user.teamId],
    );
    if (!found.rowCount) throw new HttpError(404, 'Unknown member');
    const key = generateApiKey();
    const id = await store.addKey(owner, hashApiKey(key, pepper));
    await store.pool.query('UPDATE api_keys SET label=$1 WHERE id=$2', [
      input.label,
      id,
    ]);
    res.status(201).json({ id, key });
  });
  router.delete('/keys/:id', async (req, res) => {
    const user = actor(res);
    await store.pool.query(
      `UPDATE api_keys k SET revoked_at=now() FROM users u WHERE k.id=$1 AND u.id=k.user_id AND u.team_id=$2 AND ($3='admin' OR u.id=$4)`,
      [req.params.id, user.teamId, user.role, user.userId],
    );
    res.json({ ok: true });
  });
  router.get('/audit', async (req, res) => {
    const user = actor(res);
    const before = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .parse(req.query.before);
    res.json(
      (
        await store.pool.query(
          `SELECT a.*,u.email FROM audit_calls a LEFT JOIN users u ON u.id=a.user_id WHERE a.team_id=$1 AND ($2='admin' OR a.user_id=$3) AND ($4::bigint IS NULL OR a.sequence<$4) ORDER BY a.sequence DESC LIMIT 50`,
          [user.teamId, user.role, user.userId, before ?? null],
        )
      ).rows,
    );
  });
  router.get('/conversations', async (_req, res) => {
    const user = actor(res);
    res.json(
      (
        await store.pool.query(
          'SELECT id,title,input_tokens,output_tokens,updated_at FROM conversations WHERE user_id=$1 AND team_id=$2 ORDER BY updated_at DESC LIMIT 50',
          [user.userId, user.teamId],
        )
      ).rows,
    );
  });
  router.get('/conversations/:id', async (req, res) => {
    const user = actor(res);
    const result = await store.pool.query(
      'SELECT * FROM conversations WHERE id=$1 AND user_id=$2 AND team_id=$3',
      [req.params.id, user.userId, user.teamId],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Unknown conversation');
    res.json(result.rows[0]);
  });
  router.post('/chat', async (req, res) => {
    if (!options.model)
      throw new HttpError(
        503,
        'Chat needs an OpenAI API key configured by the operator',
      );
    const user = actor(res);
    limiter(`chat:${user.userId}`, 15, 60 * 60 * 1000);
    const input = z
      .object({
        conversationId: z.string().max(100).optional(),
        message: z
          .string()
          .trim()
          .min(1, 'Message must contain 1–8000 characters')
          .max(8000),
      })
      .parse(req.body);
    if (activeChatUsers.has(user.userId) || activeChatUsers.size >= 4)
      throw new HttpError(429, 'Wait for the current answer to finish');
    activeChatUsers.add(user.userId);
    try {
      const id = input.conversationId ?? randomUUID();
      let messages = [];
      if (input.conversationId) {
        const found = await store.pool.query(
          'SELECT messages FROM conversations WHERE id=$1 AND user_id=$2 AND team_id=$3',
          [id, user.userId, user.teamId],
        );
        if (!found.rows[0]) throw new HttpError(404, 'Unknown conversation');
        messages = found.rows[0].messages;
      }
      validateChatInput(messages, input.message);
      if (!input.conversationId)
        await store.pool.query(
          'INSERT INTO conversations (id,user_id,team_id,title) VALUES ($1,$2,$3,$4)',
          [id, user.userId, user.teamId, input.message.slice(0, 80)],
        );
      const result = await runChat({
        gateway,
        actor: user,
        model: options.model,
        modelName: options.modelName,
        messages,
        message: input.message,
      });
      await store.pool.query(
        `UPDATE conversations SET messages=$1,input_tokens=input_tokens+$2,output_tokens=output_tokens+$3,updated_at=now() WHERE id=$4 AND user_id=$5 AND team_id=$6`,
        [
          JSON.stringify(result.messages),
          result.inputTokens,
          result.outputTokens,
          id,
          user.userId,
          user.teamId,
        ],
      );
      res.status(result.failure?.status ?? 200).json({
        error: result.failure ? result.text : undefined,
        failure: result.failure,
        id,
        text: result.text,
        activity: result.activity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
    } finally {
      activeChatUsers.delete(user.userId);
    }
  });
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (
        error instanceof ChatInputError ||
        error instanceof RegistryInputError ||
        error instanceof CredentialInputError
      )
        res.status(400).json({ error: error.message });
      else if (error instanceof HttpError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res.status(400).json({
          error:
            error.issues[0]?.path[0] === 'message'
              ? 'Message must contain 1–8000 non-whitespace characters'
              : 'Check the supplied fields',
          fields: error.issues.map((issue) => issue.path.join('.')),
        });
      else if (
        error instanceof Error &&
        ['23505', '22P02'].includes(String((error as { code?: string }).code))
      )
        res
          .status(409)
          .json({ error: 'This value already exists or is invalid' });
      else {
        console.error(
          'Dashboard request failed',
          error instanceof Error ? error.name : 'UnknownError',
        );
        res
          .status(503)
          .json({ error: 'The request could not be completed; try again' });
      }
    },
  );
  return router;
}
