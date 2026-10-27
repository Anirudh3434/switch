// Zero-knowledge crypto for Switch.
//
// Design:
//   1. A random 32-byte VAULT KEY is generated once per user. All snapshots are
//      sealed with it (AES-256-GCM).
//   2. The vault key is wrapped by a KEK derived from the user's password
//      (PBKDF2-SHA256, 310k iters — OWASP 2023 baseline).
//   3. The server (or the exported file) only ever sees `wrapped` + `payload`.
//
// UPGRADE PATH: swap `deriveKEK` for Argon2id (WASM, ~60KB, needs a bundler).
// PBKDF2 is here so this runs with zero build step. Argon2id is meaningfully
// stronger against offline brute force — do it before you ship publicly.
//
// Threat model: the extension holds the unwrapped vault key in memory while
// unlocked. That is the accepted cost. See README "Threat model".

const KDF_ITERATIONS = 310000;

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (str) =>
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function deriveKEK(password, saltBytes, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );
}

const importVaultKey = (raw) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);

/** Create a fresh vault for a user. Returns the exportable envelope. */
export async function createVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const vaultRaw = crypto.getRandomValues(new Uint8Array(32));
  const kek = await deriveKEK(password, salt);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    kek,
    vaultRaw,
  );

  return {
    envelope: {
      v: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: KDF_ITERATIONS, salt: b64(salt) },
      wrapped: { iv: b64(iv), data: b64(wrapped) },
    },
    vaultRaw, // caller must persist this in memory only, or wrap it again
  };
}

/** Unlock an envelope with the password. Throws on wrong password. */
export async function openVault(password, envelope) {
  const kek = await deriveKEK(
    password,
    unb64(envelope.kdf.salt),
    envelope.kdf.iter,
  );
  const vaultRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(envelope.wrapped.iv) },
    kek,
    unb64(envelope.wrapped.data),
  );
  return new Uint8Array(vaultRaw);
}

/** Seal an arbitrary object with the vault key. */
export async function seal(vaultRaw, obj) {
  const key = await importVaultKey(vaultRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(obj)),
  );
  return { iv: b64(iv), data: b64(data) };
}

/** Open a sealed payload. */
export async function open(vaultRaw, { iv, data }) {
  const key = await importVaultKey(vaultRaw);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv) },
    key,
    unb64(data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Full file format for .switchsession export. */
export async function pack(password, payloadObj) {
  const { envelope, vaultRaw } = await createVault(password);
  envelope.payload = await seal(vaultRaw, payloadObj);
  return envelope;
}

export async function unpack(password, envelope) {
  const vaultRaw = await openVault(password, envelope);
  return open(vaultRaw, envelope.payload);
}

/**
 * Retrieve or generate the persistent 256-bit vault key for sealing cloud sessions.
 */
export async function getOrCreateVaultKey() {
  const CH = (typeof chrome !== 'undefined') ? chrome : browser;
  const { vaultKeyRaw } = await CH.storage.local.get('vaultKeyRaw');
  if (vaultKeyRaw && Array.isArray(vaultKeyRaw) && vaultKeyRaw.length === 32) {
    return new Uint8Array(vaultKeyRaw);
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  await CH.storage.local.set({ vaultKeyRaw: Array.from(key) });
  return key;
}

