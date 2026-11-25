import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { createClient } from 'redis';
import { RedisStore } from 'connect-redis';
import { z } from 'zod';
import { prisma } from './db.js';
import { emailQueue } from './queue.js';
import { config } from './config.js';
import { startWorker } from './worker.js';
import { initElasticsearch, indexEmail, searchEmailsInES } from './elasticsearch.js';
import { signAuthToken, verifyAuthToken, AuthUserPayload } from './token.js';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = new Set([
  config.frontendUrl,
  'https://reachinbox-email-scheduler-2.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174'
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = origin.replace(/\/+$/, '');
    if (allowedOrigins.has(normalized) || normalized.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));

// Connect Session Redis Store with TLS support for Upstash
let sessionStore: session.Store | undefined;
let redisConnected = false;

try {
  const isTls = config.redisUrl.startsWith('rediss://');
  const redisClient = createClient({
    url: config.redisUrl,
    ...(isTls ? { socket: { tls: true, rejectUnauthorized: false } } : {})
  });
  redisClient.on('error', (err) => console.error('Session Redis error:', err.message));
  await redisClient.connect();
  redisConnected = true;
  sessionStore = new RedisStore({ client: redisClient });
  console.log('✅ Session Redis store connected');
} catch (err) {
  console.warn('⚠️ Session Redis fallback to memory store:', (err as Error).message);
}

app.use(session({
  ...(sessionStore ? { store: sessionStore } : {}),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  name: 'reachinbox.sid',
  cookie: {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user: Express.User, done) => done(null, user));

const hasGoogleConfig = Boolean(config.googleClientId && config.googleClientSecret);

if (hasGoogleConfig) {
  passport.use(new GoogleStrategy({
    clientID: config.googleClientId,
    clientSecret: config.googleClientSecret,
    callbackURL: config.googleCallbackUrl,
    proxy: true
  }, (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('Google account did not provide an email address'));
    return done(null, {
      id: profile.id,
      displayName: profile.displayName,
      name: profile.displayName,
      email,
      picture: profile.photos?.[0]?.value ?? null,
      photo: profile.photos?.[0]?.value ?? null
    });
  }));
} else {
  console.warn('⚠️ GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in environment variables!');
}

app.use(passport.initialize());
app.use(passport.session());

// Helper: Extract user from Passport session cookie OR Authorization Bearer token
function getAuthenticatedUser(req: express.Request): AuthUserPayload | null {
  if (req.isAuthenticated?.() && req.user) {
    const u = req.user as AuthUserPayload;
    return {
      id: u.id || u.email,
      email: u.email,
      name: u.name || u.displayName || u.email.split('@')[0],
      displayName: u.displayName || u.name,
      picture: u.picture || u.photo || null,
      photo: u.photo || u.picture || null
    };
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    return verifyAuthToken(token);
  }
  return null;
}

// --- Health & Auth Diagnostics ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'reachinbox-api' });
});

app.get('/auth/debug', (_req, res) => {
  res.json({
    ok: true,
    hasGoogleClientId: Boolean(config.googleClientId),
    hasGoogleClientSecret: Boolean(config.googleClientSecret),
    googleCallbackUrl: config.googleCallbackUrl,
    frontendUrl: config.frontendUrl,
    isProduction: config.isProduction,
    redisConnected
  });
});

// --- Google OAuth Routes ---
app.get('/auth/google', (req, res, next) => {
  if (!hasGoogleConfig) {
    return res.redirect(`${config.frontendUrl}/?login=failed&reason=${encodeURIComponent('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing on backend')}`);
  }
  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err: Error | null, user: Express.User | false, info?: { message?: string }) => {
    if (err || !user) {
      const reason = err?.message || info?.message || 'Google OAuth failed. Check Authorized Redirect URI and Test Users.';
      console.error('❌ Google OAuth callback error:', reason);
      return res.redirect(`${config.frontendUrl}/?login=failed&reason=${encodeURIComponent(reason)}`);
    }
    const typedUser = user as AuthUserPayload;
    const token = signAuthToken(typedUser);
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.warn('⚠️ Session cookie save warning (continuing with token auth):', loginErr.message);
        return res.redirect(`${config.frontendUrl}/?login=success&token=${encodeURIComponent(token)}`);
      }
      req.session.save(() => {
        return res.redirect(`${config.frontendUrl}/?login=success&token=${encodeURIComponent(token)}`);
      });
    });
  })(req, res, next);
});

app.get('/api/auth/me', async (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) {
    return res.status(401).json({ authenticated: false });
  }

  let slackConnected = false;
  let slackChannel: string | null = null;
  let slackTeam: string | null = null;

  try {
    const slack = await prisma.slackIntegration.findUnique({
      where: { tenantId: userObj.email }
    });
    slackConnected = Boolean(slack?.webhookUrl);
    slackChannel = slack?.channelName || null;
    slackTeam = slack?.teamName || null;
  } catch {
    // Ignore if SlackIntegration table has not been pushed yet
  }

  return res.json({
    authenticated: true,
    user: {
      id: userObj.id || userObj.email,
      email: userObj.email,
      name: userObj.name || userObj.displayName || userObj.email.split('@')[0],
      picture: userObj.picture || userObj.photo || null,
      slackConnected,
      slackChannel,
      slackTeam
    }
  });
});

app.post('/auth/logout', (req, res) => {
  const finish = () => {
    res.clearCookie('reachinbox.sid', {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: config.isProduction ? 'none' : 'lax'
    });
    return res.status(200).json({ ok: true });
  };
  if (req.logout) {
    req.logout(() => {
      if (req.session) {
        req.session.destroy(() => finish());
      } else {
        finish();
      }
    });
  } else {
    finish();
  }
});

// --- Slack OAuth Routes ---
app.get('/api/slack/connect', (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) {
    return res.status(401).json({ error: 'Please sign in first' });
  }
  if (!config.slackClientId) {
    return res.status(400).json({ error: 'SLACK_CLIENT_ID is not configured on backend' });
  }
  const state = Buffer.from(JSON.stringify({ tenantId: userObj.email })).toString('base64url');
  const scopes = 'incoming-webhook,chat:write';
  const url = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(config.slackClientId)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(config.slackRedirectUri)}&state=${encodeURIComponent(state)}`;
  return res.json({ url });
});

app.get('/api/slack/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect(`${config.frontendUrl}/?slack=error`);
  }

  try {
    const decoded = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8')) as { tenantId: string };
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.slackClientId,
        client_secret: config.slackClientSecret,
        code: String(code),
        redirect_uri: config.slackRedirectUri
      }).toString()
    });

    const data = (await tokenRes.json()) as {
      ok: boolean;
      access_token?: string;
      incoming_webhook?: { url?: string; channel?: string };
      team?: { name?: string };
    };

    if (!data.ok || !data.incoming_webhook?.url) {
      return res.redirect(`${config.frontendUrl}/?slack=error`);
    }

    await prisma.slackIntegration.upsert({
      where: { tenantId: decoded.tenantId },
      update: {
        accessToken: data.access_token || null,
        webhookUrl: data.incoming_webhook.url,
        channelName: data.incoming_webhook.channel || null,
        teamName: data.team?.name || null
      },
      create: {
        tenantId: decoded.tenantId,
        accessToken: data.access_token || null,
        webhookUrl: data.incoming_webhook.url,
        channelName: data.incoming_webhook.channel || null,
        teamName: data.team?.name || null
      }
    });

    return res.redirect(`${config.frontendUrl}/?slack=connected`);
  } catch {
    return res.redirect(`${config.frontendUrl}/?slack=error`);
  }
});

app.post('/api/slack/disconnect', async (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) {
    return res.status(401).json({ error: 'Please sign in first' });
  }
  try {
    await prisma.slackIntegration.deleteMany({ where: { tenantId: userObj.email } });
  } catch {
    // Ignore if table not present
  }
  return res.json({ ok: true });
});

// --- BullMQ Queue Dashboard ---
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter });
app.use('/admin/queues', serverAdapter.getRouter());

// --- Email Routes ---
app.get('/api/emails', async (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) return res.status(401).json({ error: 'Please sign in first' });
  const tenantId = userObj.email;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const whereStatus =
    status === 'scheduled'
      ? { in: ['scheduled', 'rate_limited'] }
      : status
        ? status
        : undefined;

  const emails = await prisma.email.findMany({
    where: { tenantId, ...(whereStatus ? { status: whereStatus } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 500
  });
  res.json(emails);
});

app.get('/api/emails/search', async (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) return res.status(401).json({ error: 'Please sign in first' });
  const tenantId = userObj.email;
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const esResults = await searchEmailsInES(tenantId, q, status);
  if (esResults) {
    return res.json(esResults);
  }

  const emails = await prisma.email.findMany({
    where: {
      tenantId,
      ...(status ? { status } : {}),
      ...(q.trim()
        ? {
            OR: [
              { recipient: { contains: q.trim(), mode: 'insensitive' } },
              { subject: { contains: q.trim(), mode: 'insensitive' } },
              { body: { contains: q.trim(), mode: 'insensitive' } }
            ]
          }
        : {})
    },
    orderBy: { createdAt: 'desc' },
    take: 500
  });
  return res.json(emails);
});

app.get('/api/emails/:id', async (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) return res.status(401).json({ error: 'Please sign in first' });
  const tenantId = userObj.email;
  const email = await prisma.email.findFirst({ where: { id: req.params.id, tenantId } });
  if (!email) return res.status(404).json({ error: 'Email not found' });
  return res.json(email);
});

const scheduleSchema = z.object({
  subject: z.string().min(1).max(250),
  body: z.string().min(1),
  recipients: z.array(z.string().email()).min(1).max(5000),
  startAt: z.string().datetime(),
  delayMs: z.number().int().min(0).max(3600000).default(config.minDelayMs),
  hourlyLimit: z.number().int().min(1).max(500).default(config.hourlyLimit),
  senderEmail: z.string().email()
});

app.post('/api/emails/schedule', async (req, res) => {
  const userObj = getAuthenticatedUser(req);
  if (!userObj) return res.status(401).json({ error: 'Please sign in first' });
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  const data = parsed.data;
  const tenantId = userObj.email;
  const start = new Date(data.startAt);
  const created = [];

  for (let i = 0; i < data.recipients.length; i++) {
    const scheduledAt = new Date(start.getTime() + i * data.delayMs);
    const email = await prisma.email.create({
      data: {
        tenantId,
        recipient: data.recipients[i],
        senderEmail: data.senderEmail,
        subject: data.subject,
        body: data.body,
        scheduledAt
      }
    });

    await emailQueue.add(
      'send-email',
      {
        emailId: email.id,
        senderEmail: data.senderEmail,
        hourlyLimit: data.hourlyLimit,
        delayMs: data.delayMs
      },
      {
        jobId: email.id,
        delay: Math.max(0, scheduledAt.getTime() - Date.now()),
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 1000,
        removeOnFail: 5000
      }
    );

    await indexEmail(email);
    created.push(email);
  }
  res.status(201).json({ count: created.length, emails: created });
});

await initElasticsearch();
await startWorker();

app.listen(config.port, () => {
  console.log(`🚀 ReachInbox API listening on port ${config.port}`);
  console.log(`🌐 Frontend CORS allowed: ${config.frontendUrl}`);
  console.log(`🔑 Google OAuth callback: ${config.googleCallbackUrl}`);
});
