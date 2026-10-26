import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { serverRoot } from '../config.js';
import { AppError } from './errors.js';

const PREFIX = 'v1';
const keyCache = new Map<string, Buffer>();

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, 'hex');
  else {
    try {
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length === 32) key = decoded;
    } catch {
      // ignore
    }
  }
  if (!key || key.length !== 32) {
    throw new AppError(500, 'SECRET_KEY_INVALID', 'SECRET_ENCRYPTION_KEY 必须是 32 字节 hex 或 base64');
  }
  return key;
}

/**
 * Returns the at-rest encryption key. Production must supply it explicitly.
 * Development may use a 0600 local key file under data/ so the SQLite demo
 * does not keep webhook secrets in plaintext.
 */
export function getSecretEncryptionKey(cfg: AppConfig): Buffer {
  const cacheKey = cfg.secretEncryptionKey || '__local_file__';
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  if (cfg.secretEncryptionKey) {
    const key = decodeKey(cfg.secretEncryptionKey);
    keyCache.set(cacheKey, key);
    return key;
  }
  if (cfg.isProduction) {
    throw new AppError(500, 'SECRET_KEY_REQUIRED', '生产环境必须配置 SECRET_ENCRYPTION_KEY');
  }
  const dataDir = path.join(serverRoot, 'data');
  const keyFile = path.join(dataDir, '.secret-key');
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(keyFile)) {
    const key = decodeKey(readFileSync(keyFile, 'utf8'));
    keyCache.set(cacheKey, key);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // best effort on platforms without POSIX modes
  }
  keyCache.set(cacheKey, key);
  return key;
}

export function resetSecretKeyCache(): void {
  keyCache.clear();
}

export function encryptSecretWithPurpose(plaintext: string, cfg: AppConfig, purpose: string): string {
  const key = getSecretEncryptionKey(cfg);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`smartstaff:${purpose}:v1`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecretWithPurpose(payload: string, cfg: AppConfig, purpose: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new AppError(500, 'SECRET_FORMAT_INVALID', '加密密钥格式无效');
  }
  const key = getSecretEncryptionKey(cfg);
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`smartstaff:${purpose}:v1`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encryptSecret(plaintext: string, cfg: AppConfig): string {
  return encryptSecretWithPurpose(plaintext, cfg, 'webhook-secret');
}

export function decryptSecret(payload: string, cfg: AppConfig): string {
  return decryptSecretWithPurpose(payload, cfg, 'webhook-secret');
}
