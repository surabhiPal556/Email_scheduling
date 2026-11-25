import { Worker, DelayedError } from 'bullmq';
import nodemailer from 'nodemailer';
import { connection } from './queue.js';
import { prisma } from './db.js';
import { config } from './config.js';
import { indexEmail } from './elasticsearch.js';
import { notifySlackRateLimit } from './slack.js';

let workerStarted = false;

async function createTransporter() {
  if (config.smtpUser && config.smtpPass) {
    console.log(`📧 Using configured SMTP account: ${config.smtpUser}`);
    return nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass }
    });
  }

  try {
    const testAccount = await nodemailer.createTestAccount();
    console.log(`📧 Auto-created Ethereal SMTP account: ${testAccount.user}`);
    return nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
  } catch (err) {
    console.warn('⚠️ Could not reach Ethereal API, using local JSON fallback transport:', (err as Error).message);
    return nodemailer.createTransport({
      jsonTransport: true
    });
  }
}

export async function startWorker() {
  if (workerStarted) return;
  workerStarted = true;

  const transporter = await createTransporter();

  const worker = new Worker(
    'email-jobs',
    async (job, token) => {
      const email = await prisma.email.findUnique({ where: { id: job.data.emailId } });
      if (!email || email.status === 'sent') return;

      const sender = String(job.data.senderEmail);
      const hourlyLimit = Number(job.data.hourlyLimit || config.hourlyLimit);
      const hour = Math.floor(Date.now() / 3600000);
      const key = `rate:${sender}:${hour}`;

      const count = await connection.incr(key);
      if (count === 1) await connection.expire(key, 7200);

      if (count > hourlyLimit) {
        await connection.decr(key);
        const nextHour = (hour + 1) * 3600000 + Math.floor(Math.random() * 3000) + 1000;
        const nextHourDate = new Date(nextHour);

        const updated = await prisma.email.update({
          where: { id: email.id },
          data: { status: 'rate_limited', scheduledAt: nextHourDate }
        });
        await indexEmail(updated);

        await notifySlackRateLimit({
          tenantId: email.tenantId,
          senderEmail: sender,
          hourlyLimit,
          hourBucket: hour,
          nextHourDate
        });

        console.log(`⏳ Rate limit (${hourlyLimit}/hr) hit for ${sender}. Rescheduled ${email.id} to ${nextHourDate.toISOString()}`);
        if (token) {
          await job.moveToDelayed(nextHour, token);
          throw new DelayedError();
        }
        return;
      }

      try {
        const info = await transporter.sendMail({
          from: sender,
          to: email.recipient,
          subject: email.subject,
          text: email.body
        });
        const previewUrl = nodemailer.getTestMessageUrl(info) || null;
        const updated = await prisma.email.update({
          where: { id: email.id },
          data: { status: 'sent', sentAt: new Date(), previewUrl }
        });
        await indexEmail(updated);
        console.log(`✅ Sent ${email.id} to ${email.recipient} | Preview: ${previewUrl || 'SMTP accepted'}`);
      } catch (error) {
        await connection.decr(key);
        const updated = await prisma.email.update({
          where: { id: email.id },
          data: { status: 'failed', error: String(error) }
        });
        await indexEmail(updated);
        throw error;
      }
    },
    {
      connection,
      concurrency: config.concurrency,
      limiter: config.minDelayMs > 0
        ? { max: 1, duration: config.minDelayMs }
        : undefined
    }
  );

  worker.on('failed', (job, err) => {
    if (err.name !== 'DelayedError') {
      console.error('❌ Job failed:', job?.id, err.message);
    }
  });

  console.log(`🚀 Email worker running (concurrency=${config.concurrency}, minDelay=${config.minDelayMs}ms)`);
}
