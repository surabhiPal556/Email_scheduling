import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

const isTls = config.redisUrl.startsWith('rediss://');

export const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  ...(isTls ? { tls: { rejectUnauthorized: false } } : {})
});

connection.on('connect', () => console.log('✅ BullMQ Redis connected'));
connection.on('error', (err) => console.error('❌ BullMQ Redis error:', err.message));

export const emailQueue = new Queue('email-jobs', { connection });
