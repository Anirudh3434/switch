// Zero-knowledge crypto for Switch.
//
// Design:
//   1. The vault key is derived deterministically from the master password and
//      account salt, so every device can reach the same key without the server
//      ever seeing it.
//   2. The key lives in chrome.storage.session (memory-backed, cleared when the
//      browser closes) — never in persistent local storage.
//   3. Envelopes are AES-256-GCM with a host-bound AAD. A server that swaps two
//      hosts' ciphertexts cannot make them decrypt successfully.
//
// UPGRADE PATH: swap PBKDF2 for Argon2id (WASM, ~60KB, needs a bundler). The
// iteration count is a protocol parameter now, so it can be raised without
// breaking existing accounts.
//
// Threat model: the extension holds the unwrapped vault key in memory while
// unlocked. That is the accepted cost.

const KDF_ITERATIONS = 600000;
const ENVELOPE_VERSION = 2;

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (str) =>
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKEK(password, saltBytes, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
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
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

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

function aadBytes(aad) {
  return aad ? enc.encode(String(aad)) : undefined;
}

/**
 * Seal an arbitrary object with the vault key.
 *
 * `aad` binds the ciphertext to a context string (we use the host). It is not
 * secret; it just makes cross-context replay fail.
 */
export async function seal(vaultRaw, obj, aad = null) {
  const key = await importVaultKey(vaultRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const algorithm = { name: 'AES-GCM', iv };
  if (aad) algorithm.additionalData = aadBytes(aad);

  const data = await crypto.subtle.encrypt(
    algorithm,
    key,
    enc.encode(JSON.stringify(obj)),
  );
  return { v: ENVELOPE_VERSION, iv: b64(iv), data: b64(data) };
}

/** Open a sealed payload. v1 envelopes predate AAD and are still readable. */
export async function open(vaultRaw, envelope, aad = null) {
  const key = await importVaultKey(vaultRaw);
  const algorithm = { name: 'AES-GCM', iv: unb64(envelope.iv) };
  if (Number(envelope.v || 1) >= 2 && aad) {
    algorithm.additionalData = aadBytes(aad);
  }
  const plain = await crypto.subtle.decrypt(
    algorithm,
    key,
    unb64(envelope.data),
  );
  return JSON.parse(dec.decode(plain));
}

/** Full file format for .switchsession export. */
export async function pack(password, payloadObj) {
  const { envelope, vaultRaw } = await createVault(password);
  envelope.payload = await seal(vaultRaw, payloadObj, 'switch:export');
  return envelope;
}

export async function unpack(password, envelope) {
  const vaultRaw = await openVault(password, envelope);
  return open(vaultRaw, envelope.payload, 'switch:export');
}

// ---------------- session-scoped vault key ----------------

export function hasVaultKey() {
  return chrome.storage.session
    .get('vaultKeyRaw')
    .then(({ vaultKeyRaw }) => Array.isArray(vaultKeyRaw) && vaultKeyRaw.length === 32)
    .catch(() => false);
}

/** Persist the derived key for this browser session only. */
export async function setVaultKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) {
    throw new Error('invalid_vault_key');
  }
  await chrome.storage.session.set({ vaultKeyRaw: Array.from(raw) });
  await chrome.storage.local.set({ vaultKeyDerived: true });
}

export async function clearVaultKey() {
  await chrome.storage.session.remove('vaultKeyRaw');
  await chrome.storage.local.remove(['vaultKeyDerived']);
}

/**
 * Returns the in-memory vault key or throws.
 *
 * This used to silently generate a random key when none existed. That is
 * catastrophic: every subsequent upload becomes undecryptable on every other
 * device, including after a reload. Refusing to operate until the user unlocks
 * is the only safe behaviour.
 */
export async function getOrCreateVaultKey() {
  const { vaultKeyRaw } = await chrome.storage.session.get('vaultKeyRaw');
  if (Array.isArray(vaultKeyRaw) && vaultKeyRaw.length === 32) {
    return new Uint8Array(vaultKeyRaw);
  }
  const err = new Error('Vault is locked. Re-enter your master password to unlock sync.');
  err.code = 'vault_locked';
  throw err;
}

export { KDF_ITERATIONS, ENVELOPE_VERSION };
