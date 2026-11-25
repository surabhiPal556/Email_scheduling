import 'dotenv/config';

function cleanEnv(val?: string): string {
  if (!val) return '';
  return val.trim().replace(/^["']|["']$/g, '');
}

const isRender = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const renderUrl = cleanEnv(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');

const defaultFrontend = isRender
  ? 'https://reachinbox-email-scheduler-2.vercel.app'
  : 'http://localhost:5173';

const rawFrontendUrl = (cleanEnv(process.env.FRONTEND_URL) || defaultFrontend).replace(/\/+$/, '');

const defaultCallbackUrl = renderUrl
  ? `${renderUrl}/auth/google/callback`
  : isRender
    ? 'https://reachinbox-email-scheduler-2-eiwq.onrender.com/auth/google/callback'
    : 'http://localhost:5000/auth/google/callback';

const defaultSlackRedirect = renderUrl
  ? `${renderUrl}/api/slack/callback`
  : isRender
    ? 'https://reachinbox-email-scheduler-2-eiwq.onrender.com/api/slack/callback'
    : 'http://localhost:5000/api/slack/callback';

export const config = {
  port: Number(cleanEnv(process.env.PORT) || 5000),
  isProduction: isRender || process.env.NODE_ENV === 'production' || rawFrontendUrl.startsWith('https://'),
  frontendUrl: rawFrontendUrl,
  redisUrl: cleanEnv(process.env.REDIS_URL) || 'redis://127.0.0.1:6379',
  elasticsearchUrl: cleanEnv(process.env.ELASTICSEARCH_URL).replace(/\/+$/, ''),
  concurrency: Number(cleanEnv(process.env.WORKER_CONCURRENCY) || 5),
  minDelayMs: Number(cleanEnv(process.env.MIN_DELAY_BETWEEN_EMAILS_MS) || 2000),
  hourlyLimit: Number(cleanEnv(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER) || 50),
  smtpHost: cleanEnv(process.env.SMTP_HOST) || 'smtp.ethereal.email',
  smtpPort: Number(cleanEnv(process.env.SMTP_PORT) || 587),
  smtpUser: cleanEnv(process.env.SMTP_USER),
  smtpPass: cleanEnv(process.env.SMTP_PASS),
  googleClientId: cleanEnv(process.env.GOOGLE_CLIENT_ID),
  googleClientSecret: cleanEnv(process.env.GOOGLE_CLIENT_SECRET),
  googleCallbackUrl: cleanEnv(process.env.GOOGLE_CALLBACK_URL) || defaultCallbackUrl,
  sessionSecret: cleanEnv(process.env.SESSION_SECRET) || 'reachinbox-persistent-session-secret-2026',
  slackClientId: cleanEnv(process.env.SLACK_CLIENT_ID),
  slackClientSecret: cleanEnv(process.env.SLACK_CLIENT_SECRET),
  slackRedirectUri: cleanEnv(process.env.SLACK_REDIRECT_URI) || defaultSlackRedirect
};
