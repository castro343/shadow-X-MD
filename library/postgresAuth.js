const { Pool } = require('pg');
const { initAuthCreds, proto } = require('@whiskeysockets/baileys');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL session storage.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', err => {
  console.error('[DATABASE] Idle PostgreSQL client error:', err.message);
});

async function initTables() {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let client;
    try {
      client = await pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
          session_id VARCHAR(255) NOT NULL,
          key_id VARCHAR(255) NOT NULL,
          key_data TEXT NOT NULL,
          PRIMARY KEY (session_id, key_id)
        );
        CREATE TABLE IF NOT EXISTS whatsapp_settings (
          session_id VARCHAR(255) PRIMARY KEY,
          settings JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS whatsapp_tenant_data (
          session_id VARCHAR(255) NOT NULL,
          data_key VARCHAR(255) NOT NULL,
          data_value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (session_id, data_key)
        );
        CREATE TABLE IF NOT EXISTS whatsapp_control_tokens (
          session_id VARCHAR(255) PRIMARY KEY,
          token_hash VARCHAR(128) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      console.log('[DATABASE] PostgreSQL tables ready.');
      return;
    } catch (err) {
      lastError = err;
      console.error(`[DATABASE] Initialization attempt ${attempt}/4 failed:`, err.message);
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    } finally {
      if (client) client.release();
    }
  }
  throw lastError;
}
const initPromise = initTables();
initPromise.catch(err => console.error('Database Init Error after retries:', err.message));

async function usePostgresAuthState(sessionId) {
  const writeData = async (data, id) => {
    await initPromise;
    await pool.query(
      `INSERT INTO whatsapp_sessions (session_id, key_id, key_data) VALUES ($1, $2, $3)
       ON CONFLICT (session_id, key_id) DO UPDATE SET key_data = EXCLUDED.key_data;`,
      [sessionId, id, JSON.stringify(data, replacer)]
    );
  };

  const readData = async (id) => {
    // A database error must never look like a missing auth key. Returning null
    // here could make Baileys initialize fresh credentials over a saved session.
    await initPromise;
    const res = await pool.query(
      'SELECT key_data FROM whatsapp_sessions WHERE session_id = $1 AND key_id = $2',
      [sessionId, id]
    );
    return res.rows.length ? JSON.parse(res.rows[0].key_data, reviver) : null;
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          await initPromise;
          if (!ids || ids.length === 0) return {};
          const keyIds = ids.map(id => `${type}-${id}`);
          
          // 🎯 FETCH ALL KEYS IN ONE QUERY
          const res = await pool.query(
            'SELECT key_id, key_data FROM whatsapp_sessions WHERE session_id = $1 AND key_id = ANY($2::varchar[])',
            [sessionId, keyIds]
          );

          const data = {};
          for (const row of res.rows) {
            const originalId = row.key_id.replace(`${type}-`, '');
            let value = JSON.parse(row.key_data, reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[originalId] = value;
          }
          return data;
        },
        set: async (data) => {
          await initPromise;
          const upserts = [];
          const deletes = [];

          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                upserts.push([sessionId, key, JSON.stringify(value, replacer)]);
              } else {
                deletes.push(key);
              }
            }
          }

          // 🎯 SAVE ALL KEYS AT ONCE USING UNNEST
          if (upserts.length > 0) {
            const query = `
              INSERT INTO whatsapp_sessions (session_id, key_id, key_data)
              SELECT * FROM UNNEST($1::varchar[], $2::varchar[], $3::text[])
              ON CONFLICT (session_id, key_id) DO UPDATE SET key_data = EXCLUDED.key_data;
            `;
            await pool.query(query, [
              upserts.map(u => u[0]),
              upserts.map(u => u[1]),
              upserts.map(u => u[2])
            ]);
          }

          // 🎯 DELETE ALL KEYS AT ONCE
          if (deletes.length > 0) {
            await pool.query('DELETE FROM whatsapp_sessions WHERE session_id = $1 AND key_id = ANY($2::varchar[])', [sessionId, deletes]);
          }
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

async function getAllSavedSessions() {
  await initPromise;
  const res = await pool.query('SELECT DISTINCT session_id FROM whatsapp_sessions');
  return res.rows.map(row => row.session_id);
}

async function deleteSession(sessionId) {
  await initPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM whatsapp_settings WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM whatsapp_control_tokens WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM whatsapp_tenant_data WHERE session_id = $1', [sessionId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function getTenantData(sessionId) {
  await initPromise;
  const res = await pool.query(
    'SELECT data_key, data_value FROM whatsapp_tenant_data WHERE session_id = $1',
    [sessionId]
  );
  return res.rows;
}

async function saveTenantData(sessionId, key, value) {
  await initPromise;
  await pool.query(
    `INSERT INTO whatsapp_tenant_data (session_id, data_key, data_value)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (session_id, data_key)
     DO UPDATE SET data_value = EXCLUDED.data_value, updated_at = NOW()`,
    [sessionId, key, JSON.stringify(value)]
  );
}

async function saveControlToken(sessionId, tokenHash) {
  await initPromise;
  await pool.query('INSERT INTO whatsapp_control_tokens (session_id, token_hash) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = NOW()', [sessionId, tokenHash]);
}

async function getControlToken(sessionId) {
  await initPromise;
  const res = await pool.query('SELECT token_hash FROM whatsapp_control_tokens WHERE session_id = $1', [sessionId]);
  return res.rows[0]?.token_hash || null;
}

async function getSessionSettings(sessionId) {
  await initPromise;
  const res = await pool.query(
    'SELECT settings FROM whatsapp_settings WHERE session_id = $1',
    [sessionId]
  );
  return res.rows.length > 0 ? res.rows[0].settings : null;
}

async function saveSessionSettings(sessionId, settings) {
  await initPromise;
  await pool.query(
    `INSERT INTO whatsapp_settings (session_id, settings) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET settings = EXCLUDED.settings;`,
    [sessionId, JSON.stringify(settings)]
  );
}

function replacer(key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { type: 'Buffer', data: value.data };
  }
  return value;
}

function reviver(key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

module.exports = {
  usePostgresAuthState,
  getAllSavedSessions,
  deleteSession,
  getSessionSettings,
  saveSessionSettings,
  getTenantData,
  saveTenantData,
  saveControlToken,
  getControlToken,
  cleanupOldSignalKeys: async () => {}
};