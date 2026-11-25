import crypto from 'node:crypto';
import { config } from './config.js';

export interface AuthUserPayload {
  id: string;
  email: string;
  name: string;
  displayName?: string;
  picture?: string | null;
  photo?: string | null;
}

export function signAuthToken(user: AuthUserPayload): string {
  const payload = {
    ...user,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAuthToken(token: string): AuthUserPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', config.sessionSecret)
      .update(encoded)
      .digest('base64url');
    if (sig !== expectedSig) return null;
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AuthUserPayload & { exp?: number };
    if (!parsed.email || (parsed.exp && Date.now() > parsed.exp)) return null;
    return {
      id: parsed.id || parsed.email,
      email: parsed.email,
      name: parsed.name || parsed.displayName || parsed.email.split('@')[0],
      displayName: parsed.displayName || parsed.name,
      picture: parsed.picture || parsed.photo || null,
      photo: parsed.photo || parsed.picture || null
    };
  } catch {
    return null;
  }
}
