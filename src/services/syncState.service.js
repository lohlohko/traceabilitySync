const { pgPool } = require('../config/postgres');
const log = require('../utils/logger');

const DEFAULT_LAST_MCID = '';

const runQuery = (client, query, params) => {
  if (client && typeof client.query === 'function') {
    return client.query(query, params);
  }

  return pgPool.query(query, params);
};

const getLastMcid = async (workerName) => {
  try {
    const query = `
      SELECT last_mcid
      FROM sync_state
      WHERE worker_name = $1
    `;

    const result = await pgPool.query(query, [workerName]);

    if (result.rows.length === 0) {
      log.warn(`Sync state not found for: ${workerName}. Initializing...`);
      await initializeSyncState(workerName);
      return DEFAULT_LAST_MCID;
    }

    return result.rows[0].last_mcid || DEFAULT_LAST_MCID;
  } catch (error) {
    log.error(`Failed to get last MCID for ${workerName}`, error);
    throw error;
  }
};

const initializeSyncState = async (workerName) => {
  try {
    const query = `
      INSERT INTO sync_state (worker_name, last_mcid, status)
      VALUES ($1, $2, 'idle')
      ON CONFLICT (worker_name) DO NOTHING
    `;

    await pgPool.query(query, [workerName, DEFAULT_LAST_MCID]);
    log.success(`Sync state initialized for: ${workerName}`);
  } catch (error) {
    log.error(`Failed to initialize sync state for ${workerName}`, error);
    throw error;
  }
};

const updateSyncProgress = async (workerName, lastMcid, client = null) => {
  try {
    const query = `
      UPDATE sync_state
      SET
        last_mcid = $1,
        last_sync_at = NOW(),
        status = 'running'
      WHERE worker_name = $2
    `;

    await runQuery(client, query, [lastMcid, workerName]);
  } catch (error) {
    log.error(`Failed to update sync progress for ${workerName}`, error);
    throw error;
  }
};

const updateSyncSuccess = async (workerName, lastMcid, client = null) => {
  try {
    const query = `
      UPDATE sync_state
      SET
        last_mcid = $1,
        last_sync_at = NOW(),
        status = 'success'
      WHERE worker_name = $2
    `;

    await runQuery(client, query, [lastMcid, workerName]);
    log.success(`Sync state updated: ${workerName} | Last MCID: ${lastMcid}`);
  } catch (error) {
    log.error(`Failed to update sync success for ${workerName}`, error);
    throw error;
  }
};

const updateSyncFailure = async (workerName) => {
  try {
    const query = `
      UPDATE sync_state
      SET
        status = 'failed',
        last_sync_at = NOW()
      WHERE worker_name = $1
    `;

    await pgPool.query(query, [workerName]);
  } catch (error) {
    log.error(`Failed to update sync failure for ${workerName}`, error);
  }
};

const setSyncRunning = async (workerName) => {
  try {
    const query = `
      UPDATE sync_state
      SET
        status = 'running',
        last_sync_at = NOW()
      WHERE worker_name = $1
    `;

    await pgPool.query(query, [workerName]);
  } catch (error) {
    log.error(`Failed to set sync running for ${workerName}`, error);
  }
};

const resetSyncState = async (workerName) => {
  try {
    const query = `
      UPDATE sync_state
      SET
        last_mcid = $1,
        last_sync_at = NULL,
        status = 'idle'
      WHERE worker_name = $2
    `;

    await pgPool.query(query, [DEFAULT_LAST_MCID, workerName]);
  } catch (error) {
    log.error(`Failed to reset sync state for ${workerName}`, error);
    throw error;
  }
};

const getSyncStatus = async (workerName) => {
  try {
    const query = `
      SELECT * FROM sync_state WHERE worker_name = $1
    `;

    const result = await pgPool.query(query, [workerName]);
    return result.rows[0] || null;
  } catch (error) {
    log.error(`Failed to get sync status for ${workerName}`, error);
    return null;
  }
};

const getSyncStatuses = async (workerNames) => {
  try {
    const query = `
      SELECT *
      FROM sync_state
      WHERE worker_name = ANY($1)
      ORDER BY worker_name ASC
    `;

    const result = await pgPool.query(query, [workerNames]);
    return result.rows;
  } catch (error) {
    log.error('Failed to get sync statuses', error);
    return [];
  }
};

module.exports = {
  getLastMcid,
  initializeSyncState,
  updateSyncProgress,
  updateSyncSuccess,
  updateSyncFailure,
  setSyncRunning,
  resetSyncState,
  getSyncStatus,
  getSyncStatuses
};
