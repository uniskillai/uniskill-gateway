// src/utils/security.ts
// Logic: Portable encryption utility for both Next.js and Cloudflare Workers (AES-256-GCM)
// 逻辑：兼容 Next.js 和 Workers 的加解密工具，采用强认证加密 AES-256-GCM

import * as crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Encrypt a plain text secret using the master key.
 * @param plainText Clear text to encrypt
 * @param masterKeyHex 64-character hex string (32 bytes)
 * @returns Combined string: iv.authTag.encryptedData
 */
export function encryptSecret(plainText: string, masterKeyHex: string): string {
    if (!masterKeyHex || masterKeyHex.length !== 64) {
        throw new Error('[Security] Invalid masterKey. Expected 64-character hex string.');
    }

    const key = Buffer.from(masterKeyHex, 'hex');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}.${authTag}.${encrypted}`;
}

/**
 * Decrypt a combined secret string using the master key.
 * @param combinedText The iv.authTag.encryptedData string
 * @param masterKeyHex 64-character hex string (32 bytes)
 * @returns Original plain text
 */
export function decryptSecret(combinedText: string, masterKeyHex: string): string {
    if (!masterKeyHex || masterKeyHex.length !== 64) {
        throw new Error('[Security] Invalid masterKey. Expected 64-character hex string.');
    }

    const key = Buffer.from(masterKeyHex, 'hex');
    const parts = combinedText.split('.');
    if (parts.length !== 3) {
        throw new Error('[Security] Invalid encrypted format. Expected iv.tag.data');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
