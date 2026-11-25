import { config } from './config.js';

const INDEX_NAME = 'reachinbox-emails';

export async function initElasticsearch(): Promise<void> {
  if (!config.elasticsearchUrl) {
    console.log('ℹ️ ELASTICSEARCH_URL not set — search uses PostgreSQL fallback');
    return;
  }

  try {
    const check = await fetch(`${config.elasticsearchUrl}/${INDEX_NAME}`);
    if (check.status === 404) {
      await fetch(`${config.elasticsearchUrl}/${INDEX_NAME}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: {
            properties: {
              id: { type: 'keyword' },
              tenantId: { type: 'keyword' },
              recipient: { type: 'text' },
              senderEmail: { type: 'keyword' },
              subject: { type: 'text' },
              body: { type: 'text' },
              status: { type: 'keyword' },
              scheduledAt: { type: 'date' },
              sentAt: { type: 'date' }
            }
          }
        })
      });
    }
    console.log('✅ Elasticsearch index ready');
  } catch (err) {
    console.warn('⚠️ Elasticsearch unreachable, using PostgreSQL fallback:', (err as Error).message);
  }
}

export async function indexEmail(email: {
  id: string;
  tenantId: string;
  recipient: string;
  senderEmail: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date;
  sentAt?: Date | null;
  previewUrl?: string | null;
}): Promise<void> {
  if (!config.elasticsearchUrl) return;
  try {
    await fetch(`${config.elasticsearchUrl}/${INDEX_NAME}/_doc/${encodeURIComponent(email.id)}?refresh=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(email)
    });
  } catch {
    // Non-blocking
  }
}

export async function searchEmailsInES(tenantId: string, query: string, status?: string) {
  if (!config.elasticsearchUrl) return null;

  try {
    const must: unknown[] = [{ term: { tenantId } }];
    if (status) {
      must.push({ term: { status } });
    }
    if (query.trim()) {
      must.push({
        multi_match: {
          query: query.trim(),
          fields: ['recipient^2', 'subject^2', 'body'],
          fuzziness: 'AUTO'
        }
      });
    }

    const response = await fetch(`${config.elasticsearchUrl}/${INDEX_NAME}/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: 200,
        query: { bool: { must } }
      })
    });

    if (!response.ok) return null;
    const data = (await response.json()) as { hits?: { hits?: Array<{ _source: unknown }> } };
    return data.hits?.hits?.map((h) => h._source) ?? [];
  } catch {
    return null;
  }
}
