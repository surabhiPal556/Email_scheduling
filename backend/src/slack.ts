import { prisma } from './db.js';
import { connection } from './queue.js';

export async function notifySlackRateLimit(params: {
  tenantId: string;
  senderEmail: string;
  hourlyLimit: number;
  hourBucket: number;
  nextHourDate: Date;
}): Promise<void> {
  try {
    const dedupeKey = `slack_alert:${params.tenantId}:${params.senderEmail}:${params.hourBucket}`;
    const isFirstAlert = await connection.set(dedupeKey, '1', 'EX', 3700, 'NX');
    if (!isFirstAlert) return;

    const integration = await prisma.slackIntegration.findUnique({
      where: { tenantId: params.tenantId }
    });

    if (!integration || !integration.webhookUrl) return;

    const payload = {
      text: `⚠️ *ReachInbox Hourly Rate Limit Reached*\n• *Sender:* ${params.senderEmail}\n• *Hourly Quota:* ${params.hourlyLimit} emails/hr\n• *Action Taken:* Remaining emails were rescheduled to *${params.nextHourDate.toUTCString()}*.`
    };

    const res = await fetch(integration.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log(`🔔 Slack notification sent for ${params.senderEmail}`);
    }
  } catch (err) {
    console.warn('⚠️ Slack notification skipped:', (err as Error).message);
  }
}
