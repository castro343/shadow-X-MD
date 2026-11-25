// Per-WhatsApp-account storage helpers for SHADOW X MD.
const fs = require('fs');
const path = require('path');
const { getTenantData, saveTenantData } = require('./postgresAuth');

const ROOT = path.join(__dirname, '..');
const SESSIONS = path.join(ROOT, 'sessions');
const MAIN_OWNER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');

function phoneOf(sock) {
  const raw = sock?.user?.id || sock?.user?.jid || '';
  const num = String(raw).split('@')[0].split(':')[0].replace(/\D/g, '');
  return /^\d{7,15}$/.test(num) ? num : '';
}

function dirOf(sock) {
  const phone = phoneOf(sock);
  if (!phone) throw new Error('Cannot identify this WhatsApp account.');
  const dir = path.join(SESSIONS, phone);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileOf(sock, name) {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error('Invalid tenant data filename.');
  return path.join(dirOf(sock), name);
}

const cache = new Map();
const TTL = 5000;

const hydrated = new Set();

async function hydrate(sock) {
  const phone = phoneOf(sock);
  if (!phone || hydrated.has(phone)) return;
  const rows = await getTenantData(phone);
  const stored = new Set();
  for (const row of rows) {
    const key = phone + '/' + row.data_key;
    const raw = JSON.stringify(row.data_value);
    cache.set(key, { t: Infinity, raw });
    stored.add(row.data_key);
  }

  // One-time migration: preserve existing local tenant JSON files when
  // they have not yet been copied into PostgreSQL.
  try {
    const dir = dirOf(sock);
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name) || stored.has(name)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        await saveTenantData(phone, name, data);
        cache.set(phone + '/' + name, { t: Infinity, raw: JSON.stringify(data) });
      } catch (error) {
        console.error('[TENANT] Could not migrate', name, 'for session', phone, error.message);
      }
    }
  } catch (error) {
    console.error('[TENANT] Local migration skipped for session', phone, error.message);
  }
  hydrated.add(phone);
}

function readRaw(sock, name) {
  const phone = phoneOf(sock);
  const key = phone + '/' + name;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.raw;

  let raw = null;
  try {
    raw = fs.readFileSync(fileOf(sock, name), 'utf8');
  } catch {}

  if (phone) cache.set(key, { t: Date.now(), raw });
  return raw;
}

function read(sock, name, fallback = {}) {
  const raw = readRaw(sock, name);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return JSON.parse(JSON.stringify(fallback));
}

function write(sock, name, data) {
  const file = fileOf(sock, name);
  const temp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(data, null, 2);
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, file);
  const phone = phoneOf(sock);
  cache.set(phone + '/' + name, { t: Date.now(), raw: body });
  if (phone) {
    saveTenantData(phone, name, data).catch(err =>
      console.error('[TENANT] Could not persist', name, 'for session', phone, err.message)
    );
  }
  return true;
}

function forget(phone) {
  const prefix = String(phone) + '/';
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
  hydrated.delete(String(phone));
}

function isMainOwner(sender) {
  return !!MAIN_OWNER && String(sender || '').split('@')[0].split(':')[0].replace(/\D/g, '') === MAIN_OWNER;
}

function isAccountOwner(sender, sock) {
  const num = String(sender || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return !!num && (num === phoneOf(sock) || isMainOwner(num));
}

module.exports = {
  ROOT, SESSIONS, MAIN_OWNER,
  phoneOf, dirOf, fileOf,
  read, write, hydrate, forget,
  isMainOwner, isAccountOwner
};
