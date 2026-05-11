const { mysqlPool } = require('../config/mysql');
const { pgPool } = require('../config/postgres');
const log = require('../utils/logger');
const {
  getLastMcid,
  initializeSyncState,
  updateSyncProgress,
  updateSyncSuccess,
  updateSyncFailure,
  setSyncRunning,
  resetSyncState
} = require('./syncState.service');

const TRACEABILITY_WORKER_NAME = 'traceability_anchor';

const TRACEABILITY_ANCHOR = {
  mysqlTable: 'prod_plc_log_ma',
  mcidColumn: 'ppl_mc_id',
  columnMap: {
    ma_line: 'ppl_line_area',
    ma_datetime: 'ppl_datetime'
  }
};

const TRACEABILITY_TABLES = [
  TRACEABILITY_ANCHOR,
  {
    mysqlTable: 'prod_plc_log_te',
    mcidColumn: 'ppl_mc_id',
    columnMap: {
      te_line: 'ppl_line_area',
      te_datetime: 'ppl_datetime'
    }
  },
  {
    mysqlTable: 'prod_plc_log_al',
    mcidColumn: 'ppl_mc_id',
    columnMap: {
      al_line: 'ppl_line_area',
      al_npk: 'ppl_op_npk',
      al_datetime: 'ppl_datetime'
    }
  },
  {
    mysqlTable: 'prod_plc_log_sa',
    mcidColumn: 'ppl_mc_id',
    columnMap: {
      sa_line: 'ppl_line_area',
      sa_datetime: 'ppl_datetime'
    }
  },
  {
    mysqlTable: 'prod_plc_log_fi',
    mcidColumn: 'ppl_mc_id',
    columnMap: {
      ft_line: 'ppl_line_area',
      ft_datetime: 'ppl_datetime'
    }
  },
  {
    mysqlTable: 'prod_assy_lot_print',
    mcidColumn: 'as_mc_id',
    columnMap: {
      as_line: 'as_line_area',
      as_lot: 'as_lot_id',
      as_datetime: 'as_datetime'
    }
  },
//   {
//     workerName: 'pick_log',
//     mysqlTable: 'prod_pick_log',
//     mcidColumn: 'ppl_mc_id',
//     columnMap: {
//       dly_npk: 'ppl_pick_npk',
//       dlv_dock: 'ppl_dock',
//       dlv_customer: 'ppl_del_note',
//       dlv_datetime: 'ppl_pick_datetime'
//     }
//   }
];

const BATCH_SIZE = parseInt(process.env.TRACE_SYNC_BATCH_SIZE || process.env.SYNC_BATCH_SIZE || '500', 10);
const RECHECK_LIMIT = parseInt(process.env.TRACE_RECHECK_LIMIT || '200', 10);

const normalizeMcid = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
};

const normalizeLotId = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
};

const parseDate = (dateValue) => {
  if (!dateValue || dateValue === '' || dateValue === '0000-00-00' || dateValue === '0000-00-00 00:00:00') {
    return null;
  }

  if (dateValue instanceof Date) {
    return isNaN(dateValue.getTime()) ? null : dateValue;
  }

  try {
    const parsed = new Date(dateValue);
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
};

const normalizeValue = (targetColumn, sourceValue) => {
  if (targetColumn.endsWith('_datetime')) {
    return parseDate(sourceValue);
  }

  return sourceValue === undefined ? null : sourceValue;
};

const buildUpsertQuery = (columnMap, row, mcid) => {
  const targetColumns = Object.keys(columnMap);
  const columns = ['mcid', ...targetColumns];
  const values = [mcid];

  for (const targetColumn of targetColumns) {
    const sourceColumn = columnMap[targetColumn];
    values.push(normalizeValue(targetColumn, row[sourceColumn]));
  }

  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const updates = targetColumns.map((column) => `${column} = EXCLUDED.${column}`);

  const query = `
    INSERT INTO traceability_report (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (mcid) DO UPDATE
    SET ${updates.join(', ')}
  `;

  return { query, values };
};

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const fetchAnchorBatch = async (lastMcid) => {
  const query = `
    SELECT ${TRACEABILITY_ANCHOR.mcidColumn} AS mcid
    FROM ${TRACEABILITY_ANCHOR.mysqlTable}
    WHERE ${TRACEABILITY_ANCHOR.mcidColumn} > ?
    ORDER BY ${TRACEABILITY_ANCHOR.mcidColumn} ASC
    LIMIT ?
  `;

  const [rows] = await mysqlPool.query(query, [lastMcid, BATCH_SIZE]);
  return rows.map((row) => normalizeMcid(row.mcid));
};

const fetchRecentAnchorMcids = async (limit) => {
  if (limit <= 0) {
    return [];
  }

  const query = `
    SELECT ${TRACEABILITY_ANCHOR.mcidColumn} AS mcid
    FROM ${TRACEABILITY_ANCHOR.mysqlTable}
    ORDER BY ${TRACEABILITY_ANCHOR.mcidColumn} DESC
    LIMIT ?
  `;

  const [rows] = await mysqlPool.query(query, [limit]);
  return rows.map((row) => normalizeMcid(row.mcid));
};

const TRACEABILITY_FG_LOG = {
  mysqlTable: 'prod_fg_log',
  lotIdColumn: 'fgs_lot_id',
  columnMap: {
    as_kanban: 'fgs_kanban',
    as_box: 'fgs_box_siam',
    as_pn_internal: 'fgs_part_no',
    as_npk: 'fgs_npk_op'
  }
};

const TRACEABILITY_PICK_LOG = {
  mysqlTable: 'prod_pick_log',
  lotIdColumn: 'ppl_lot_id',
  columnMap: {
    dlv_npk: 'ppl_pick_npk',
    dlv_dock: 'ppl_dock',
    dlv_customer: 'ppl_del_note',
    dlv_datetime: 'ppl_pick_datetime'
  }
};

const fetchRowsByMcids = async (tableConfig, mcids) => {
  const rows = [];
  const batches = chunkArray(mcids, 800);

  for (const batch of batches) {
    const query = `
      SELECT *
      FROM ${tableConfig.mysqlTable}
      WHERE ${tableConfig.mcidColumn} IN (?)
    `;

    const [batchRows] = await mysqlPool.query(query, [batch]);
    rows.push(...batchRows);
  }

  return rows;
};

const fetchRowsByValues = async (tableName, columnName, values) => {
  const rows = [];
  const batches = chunkArray(values, 800);

  for (const batch of batches) {
    const query = `
      SELECT *
      FROM ${tableName}
      WHERE ${columnName} IN (?)
    `;

    const [batchRows] = await mysqlPool.query(query, [batch]);
    rows.push(...batchRows);
  }

  return rows;
};

const writeSyncLog = async (logEntry) => {
  const query = `
    INSERT INTO sync_logs (
      worker_name,
      start_mcid,
      end_mcid,
      total_rows,
      status,
      error_message,
      started_at,
      finished_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `;

  const values = [
    logEntry.workerName,
    logEntry.startMcid,
    logEntry.endMcid,
    logEntry.totalRows,
    logEntry.status,
    logEntry.errorMessage,
    logEntry.startedAt,
    logEntry.finishedAt
  ];

  try {
    await pgPool.query(query, values);
  } catch (error) {
    log.warn(`Failed to write sync log for ${logEntry.workerName}`, error.message);
  }
};

const upsertRows = async (client, tableConfig, rows) => {
  let upserted = 0;

  for (const row of rows) {
    const mcid = normalizeMcid(row[tableConfig.mcidColumn]);
    if (!mcid) {
      continue;
    }

    const { query, values } = buildUpsertQuery(tableConfig.columnMap, row, mcid);
    await client.query(query, values);
    upserted += 1;
  }

  return upserted;
};

const upsertRowsByLotId = async (client, tableConfig, rows, lotIdToMcid) => {
  let upserted = 0;

  for (const row of rows) {
    const lotId = normalizeLotId(row[tableConfig.lotIdColumn]);
    if (!lotId) {
      continue;
    }

    const mcid = lotIdToMcid.get(lotId);
    if (!mcid) {
      continue;
    }

    const { query, values } = buildUpsertQuery(tableConfig.columnMap, row, mcid);
    await client.query(query, values);
    upserted += 1;
  }

  return upserted;
};

const syncTraceability = async () => {
  const startedAt = new Date();
  let totalUpserts = 0;
  let lastMcid = '';

  try {
    await initializeSyncState(TRACEABILITY_WORKER_NAME);
    await setSyncRunning(TRACEABILITY_WORKER_NAME);

    lastMcid = await getLastMcid(TRACEABILITY_WORKER_NAME);
    const startMcid = lastMcid || '';

    const newMcids = await fetchAnchorBatch(lastMcid || '');
    const recentMcids = await fetchRecentAnchorMcids(RECHECK_LIMIT);
    const mcidSet = new Set([...newMcids, ...recentMcids].filter((value) => value));
    const mcids = Array.from(mcidSet);

    if (mcids.length === 0) {
      await updateSyncSuccess(TRACEABILITY_WORKER_NAME, lastMcid || '');
      await writeSyncLog({
        workerName: TRACEABILITY_WORKER_NAME,
        startMcid,
        endMcid: lastMcid || startMcid,
        totalRows: 0,
        status: 'success',
        errorMessage: null,
        startedAt,
        finishedAt: new Date()
      });

      return { success: true, worker: TRACEABILITY_WORKER_NAME, totalRows: 0, lastMcid };
    }

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      let assyRows = [];

      for (const tableConfig of TRACEABILITY_TABLES) {
        const rows = await fetchRowsByMcids(tableConfig, mcids);
        totalUpserts += await upsertRows(client, tableConfig, rows);

        if (tableConfig.mysqlTable === 'prod_assy_lot_print') {
          assyRows = rows;
        }
      }

      const lotIds = Array.from(
        new Set(
          assyRows
            .map((row) => normalizeLotId(row.as_lot_id))
            .filter((value) => value)
        )
      );

      if (lotIds.length > 0) {
        const lotIdToMcid = new Map(
          assyRows
            .map((row) => [normalizeLotId(row.as_lot_id), normalizeMcid(row.as_mc_id)])
            .filter(([lotId, mcid]) => lotId && mcid)
        );

        const fgRows = await fetchRowsByValues(
          TRACEABILITY_FG_LOG.mysqlTable,
          TRACEABILITY_FG_LOG.lotIdColumn,
          lotIds
        );
        totalUpserts += await upsertRowsByLotId(client, TRACEABILITY_FG_LOG, fgRows, lotIdToMcid);

        const pickRows = await fetchRowsByValues(
          TRACEABILITY_PICK_LOG.mysqlTable,
          TRACEABILITY_PICK_LOG.lotIdColumn,
          lotIds
        );
        totalUpserts += await upsertRowsByLotId(client, TRACEABILITY_PICK_LOG, pickRows, lotIdToMcid);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const endMcid = newMcids.length > 0 ? newMcids[newMcids.length - 1] : lastMcid;
    await updateSyncSuccess(TRACEABILITY_WORKER_NAME, endMcid || '');

    await writeSyncLog({
      workerName: TRACEABILITY_WORKER_NAME,
      startMcid,
      endMcid: endMcid || startMcid,
      totalRows: totalUpserts,
      status: 'success',
      errorMessage: null,
      startedAt,
      finishedAt: new Date()
    });

    return { success: true, worker: TRACEABILITY_WORKER_NAME, totalRows: totalUpserts, lastMcid: endMcid };
  } catch (error) {
    await updateSyncFailure(TRACEABILITY_WORKER_NAME);

    await writeSyncLog({
      workerName: TRACEABILITY_WORKER_NAME,
      startMcid: lastMcid || '',
      endMcid: lastMcid || '',
      totalRows: totalUpserts,
      status: 'failed',
      errorMessage: error.message,
      startedAt,
      finishedAt: new Date()
    });

    log.error('Traceability sync failed', error);
    return { success: false, worker: TRACEABILITY_WORKER_NAME, error: error.message };
  }
};

const syncTraceabilityInitial = async () => {
  await initializeSyncState(TRACEABILITY_WORKER_NAME);
  await resetSyncState(TRACEABILITY_WORKER_NAME);
  return syncTraceability();
};

const getTraceabilityWorkerNames = () => [TRACEABILITY_WORKER_NAME];

module.exports = {
  TRACEABILITY_TABLES,
  getTraceabilityWorkerNames,
  syncTraceability,
  syncTraceabilityInitial
};
