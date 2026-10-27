// MongoDB connection + collection helpers.
//
// Schema (all documents):
//   users        { _id, email, authHash, kdfSalt, publicKey, createdAt }
//   sessions     { _id, userId, host, envelope, version, updatedAt, deviceId, deleted }
//   refresh      { _id, userId, tokenHash, expiresAt, revokedAt }
//   shares       { _id, fromUserId, toUserId, host, envelope, createdAt, consumedAt }
//   devices      { _id, userId, deviceId, name, lastSeenAt }
//   recoveryKeys { _id, userId, keyHash, createdAt, usedAt }
//
// CRITICAL: `envelope` is always client-encrypted ciphertext. The server has
// no key and must never be given one. If you ever find yourself adding a
// decryption path here, you have broken the product's core promise.

import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;
let db;

export async function connect() {
  client = new MongoClient(config.mongoUri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(config.dbName);
  await ensureIndexes();
  return db;
}

export async function close() {
  await client?.close();
}

async function ensureIndexes() {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  // Drop legacy index if it exists
  try {
    await db.collection('sessions').dropIndex('userId_1_host_1');
  } catch {}
  // Per-user, per-device, per-host session storage so devices don't overwrite each other
  await db
    .collection('sessions')
    .createIndex({ userId: 1, deviceId: 1, host: 1 }, { unique: true });
  await db.createIndex('sessions', { userId: 1, updatedAt: -1 });
  await db.createIndex('refresh', { tokenHash: 1 }, { unique: true });
  await db.createIndex('refresh', { expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.createIndex('shares', { toUserId: 1, consumedAt: 1, createdAt: -1 });
  await db.createIndex('devices', { userId: 1, deviceId: 1 }, { unique: true });
  // OTP Verification Collection (with TTL index for automatic expiry)
  await db.collection('otps').createIndex({ email: 1 });
  await db.collection('otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  // Feedback Collection
  await db.collection('feedbacks').createIndex({ createdAt: -1 });
  await db.collection('feedbacks').createIndex({ type: 1 });
  // Recovery Keys
  await db.collection('recoveryKeys').createIndex({ userId: 1 });
  await db.collection('recoveryKeys').createIndex({ keyHash: 1 });
}

export const users = () => db.collection('users');
export const sessions = () => db.collection('sessions');
export const refresh = () => db.collection('refresh');
export const shares = () => db.collection('shares');
export const devices = () => db.collection('devices');
export const otps = () => db.collection('otps');
export const feedbacks = () => db.collection('feedbacks');
export const recoveryKeys = () => db.collection('recoveryKeys');

