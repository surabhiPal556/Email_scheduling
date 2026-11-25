# ReachInbox — Full-Stack Email Job Scheduler

A production-grade distributed email scheduling service and dashboard built with **TypeScript, Express.js, BullMQ, Redis, PostgreSQL (Prisma), Ethereal SMTP, Elasticsearch, Slack OAuth, and React (Vite + Tailwind CSS)**.

-------

## Architecture Overview

1. **Scheduling Engine (Zero Cron):**
   - `POST /api/emails/schedule` stores email jobs in PostgreSQL via Prisma and enqueues delayed jobs into **BullMQ** backed by **Redis** (`delay = max(0, scheduledAt - now)`).
   - Each job uses a deterministic BullMQ `jobId` (`email.id`) plus a pre-send status check (`email.status === 'sent'`) to guarantee **idempotency** across retries and restarts.
2. **Server Restart Persistence:**
   - Delayed and active job states are persisted in Redis, while durable campaign records live in PostgreSQL.
   - If the Node server stops and restarts, pending future jobs execute at their exact scheduled timestamps without dropping or duplicating already-sent emails.
3. **Throughput, Concurrency & Rate Limiting:**
   - **Configurable Worker Concurrency:** Set via `WORKER_CONCURRENCY`.
   - **Minimum Delay Between Emails:** Enforced via BullMQ's worker `limiter` (`MIN_DELAY_BETWEEN_EMAILS_MS`, default `2000ms`).
   - **Distributed Per-Sender Hourly Rate Limit:** Tracked atomically in Redis (`INCR rate:<sender>:<hourBucket>`). When `hourlyLimit` is exceeded, jobs are **not dropped or failed**—they are moved via `job.moveToDelayed(nextHour, token)` to the start of the next hour window and marked `rate_limited`.
4. **Live Slack Notifications:**
   - Real Slack OAuth v2 flow (`/api/slack/connect` → `/api/slack/callback`) stores the workspace webhook per user. When a sender hits their hourly limit, a live Slack alert is sent immediately (deduplicated per sender/hour). If Slack is disconnected, the worker continues cleanly without crashing.
5. **Search & Live Queue Dashboard:**
   - Emails are indexed in **Elasticsearch** (`GET /api/emails/search`) with automatic PostgreSQL fallback.
   - Live **Bull Board** queue dashboard is mounted at `/admin/queues`.

---

## Local Setup

1. **Backend:**
   ```bash
   cd backend
   cp .env.example .env
   npm install
   npx prisma generate
   npx prisma db push
   npm run dev
   ```
2. **Frontend:**
   ```bash
   cd frontend
   cp .env.example .env
   npm install
   npm run dev
   ```

---

## Assumptions & Trade-offs
- **Ethereal SMTP Auto-Provisioning:** If `SMTP_USER` and `SMTP_PASS` are omitted, the worker automatically provisions a test account via `nodemailer.createTestAccount()` and attaches Ethereal preview URLs to sent emails.
- **Elasticsearch Resilience:** When `ELASTICSEARCH_URL` is configured, all emails are indexed and searched in Elasticsearch; if omitted in free-tier cloud hosting, search seamlessly falls back to PostgreSQL.
