const { mysqlPool } = require('../config/mysql');
const { pgPool, pgTransactionsPool } = require('../config/postgres');
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
const DEFAULT_TRANSACTIONS_SCHEMA = 'public';

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
    mysqlTable: 'prod_assy_lot_print',
    mcidColumn: 'as_mc_id',
    columnMap: {
      as_line: 'as_line_area',
      as_datetime: 'as_datetime',
      as_lot: 'as_lot_id'
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
];

const BATCH_SIZE = parseInt(process.env.TRACE_SYNC_BATCH_SIZE || process.env.SYNC_BATCH_SIZE || '500', 10);
const RECHECK_LIMIT = parseInt(process.env.TRACE_RECHECK_LIMIT || '200', 10);

const normalizeMcid = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim().replace(/\0/g, '');
};

const normalizeLotId = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim().replace(/\0/g, '');
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

  if (typeof sourceValue === 'string') {
    return sourceValue.replace(/\0/g, '');
  }

  return sourceValue === undefined ? null : sourceValue;
};

const getTransactionsSchema = () => {
  const raw = process.env.PG_TRANSACTIONS_SCHEMA || DEFAULT_TRANSACTIONS_SCHEMA;
  const value = String(raw || '').trim();
  if (!value) {
    return DEFAULT_TRANSACTIONS_SCHEMA;
  }

  return /^[A-Za-z0-9_]+$/.test(value) ? value : DEFAULT_TRANSACTIONS_SCHEMA;
};

const hasTransactionsConfig = () => {
  return Boolean(process.env.PG_TRANSACTIONS_HOST && process.env.PG_TRANSACTIONS_DATABASE && process.env.PG_TRANSACTIONS_USER);
};

const buildUpsertQuery = (columnMap, row, mcid) => {
  const targetColumns = Object.keys(columnMap);
  const columns = ['mcid', 'model', ...targetColumns];
  const values = [mcid, mcid ? mcid.slice(0, 5) : ''];

  for (const targetColumn of targetColumns) {
    const sourceColumn = columnMap[targetColumn];
    values.push(normalizeValue(targetColumn, row[sourceColumn]));
  }

  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const updates = ['model = EXCLUDED.model', ...targetColumns.map((column) => `${column} = EXCLUDED.${column}`)];

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
    SELECT mcid FROM (
      SELECT ppl_mc_id AS mcid FROM prod_plc_log_ma WHERE ppl_mc_id > ?
      UNION
      SELECT as_mc_id AS mcid FROM prod_assy_lot_print WHERE as_mc_id > ?
    ) AS combined
    ORDER BY mcid ASC
    LIMIT ?
  `;

  const [rows] = await mysqlPool.query(query, [lastMcid, lastMcid, BATCH_SIZE]);
  return rows.map((row) => normalizeMcid(row.mcid));
};

const RECHECK_HOURS = parseInt(process.env.RECHECK_HOURS || '24', 10);

const fetchRecheckAnchorMcids = async () => {
  const query = `
    SELECT mcid FROM (
      SELECT ppl_mc_id AS mcid FROM prod_plc_log_ma
        WHERE ppl_datetime >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      UNION
      SELECT as_mc_id AS mcid FROM prod_assy_lot_print
        WHERE as_datetime >= DATE_SUB(NOW(), INTERVAL ? HOUR)
    ) AS combined
    ORDER BY mcid ASC
  `;

  const [rows] = await mysqlPool.query(query, [RECHECK_HOURS, RECHECK_HOURS]);
  return rows.map((row) => normalizeMcid(row.mcid));
};


const TRACEABILITY_FG_LOG = {
  mysqlTable: 'prod_fg_log',
  lotIdColumn: 'fgs_lot_id',
  columnMap: {
    as_kanban: 'fgs_kanban',
    as_box: 'fgs_box_siam',
    as_pn_internal: 'fgs_part_no',
    as_npk: 'fgs_npk_op',
    as_line: 'fgs_area',
    fi_datetime: 'fgs_datetime'
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
      finished_at,
      production_date_from,
      production_date_to
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `;

  const values = [
    logEntry.workerName,
    logEntry.startMcid,
    logEntry.endMcid,
    logEntry.totalRows,
    logEntry.status,
    logEntry.errorMessage,
    logEntry.startedAt,
    logEntry.finishedAt,
    logEntry.productionDateFrom || null,
    logEntry.productionDateTo || null
  ];

  try {
    const result = await pgPool.query(query, values);
    return result.rows[0]?.id;
  } catch (error) {
    log.warn(`Failed to write sync log for ${logEntry.workerName}`, error.message);
    return null;
  }
};

const updateSyncLogProgress = async (id, totalRows, status, errorMessage, finishedAt = null) => {
  if (!id) return;
  const query = `
    UPDATE sync_logs 
    SET total_rows = $1, status = $2, error_message = $3, finished_at = $4
    WHERE id = $5
  `;
  try {
    await pgPool.query(query, [totalRows, status, errorMessage, finishedAt, id]);
  } catch (error) {
    log.warn(`Failed to update sync log progress for id ${id}`, error.message);
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

const fetchAssyTransactionsByLot = async (lotIds) => {
  if (!lotIds.length) {
    return [];
  }

  if (!hasTransactionsConfig()) {
    log.warn('Transactions DB config missing. Skipping AS transactions sync.');
    return [];
  }

  const schema = getTransactionsSchema();

  const query = `
    SELECT
      t.lot,
      t.npk,
      t.area,
      t.datetime_scan,
      i.item_code
    FROM ${schema}.transactions t
    LEFT JOIN ${schema}.items i ON t.item_id = i.id
    WHERE t.lot = ANY($1)
      AND t.area LIKE 'AS-%'
    ORDER BY t.lot ASC, t.datetime_scan DESC
  `;

  const result = await pgTransactionsPool.query(query, [lotIds]);
  return result.rows || [];
};

const mapLatestAssyByLot = (rows) => {
  const assyByLot = new Map();

  for (const row of rows) {
    const lotId = normalizeLotId(row.lot);
    if (!lotId || assyByLot.has(lotId)) {
      continue;
    }

    assyByLot.set(lotId, {
      as_line: row.area,
      as_npk: row.npk,
      as_datetime: row.datetime_scan,
      as_pn_internal: row.item_code
    });
  }

  return assyByLot;
};

const updateAssyFromTransactions = async (client, lotIdToMcid, assyByLot) => {
  let updated = 0;
  const query = `
    UPDATE traceability_report
    SET
      as_line     = COALESCE(NULLIF(as_line, ''), $2),
      as_npk      = COALESCE(NULLIF(as_npk, ''), $3),
      as_datetime = COALESCE(as_datetime, $4),
      as_pn_internal = COALESCE(NULLIF(as_pn_internal, ''), $5)
    WHERE mcid = $1
  `;

  for (const [lotId, payload] of assyByLot.entries()) {
    const mcid = lotIdToMcid.get(lotId);
    if (!mcid) {
      continue;
    }

    const hasValue = Boolean(
      payload.as_line ||
      payload.as_npk ||
      payload.as_datetime ||
      payload.as_pn_internal
    );

    if (!hasValue) {
      continue;
    }

    const values = [
      mcid,
      payload.as_line || null,
      payload.as_npk || null,
      payload.as_datetime || null,
      payload.as_pn_internal || null
    ];

    const result = await client.query(query, values);
    updated += result.rowCount;
  }

  return updated;
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
    const recentMcids = await fetchRecheckAnchorMcids();
    const mcidSet = new Set([...newMcids, ...recentMcids].filter((value) => value));
    const mcids = Array.from(mcidSet);

    log.info(`[TRACEABILITY] Starting sync. New MCIDs: ${newMcids.length}, Recheck (last ${RECHECK_HOURS}h): ${recentMcids.length}, Total Unique: ${mcids.length}`);

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
        const upsertedCount = await upsertRows(client, tableConfig, rows);
        totalUpserts += upsertedCount;

        log.info(`[TRACEABILITY] Synced ${upsertedCount} rows from MySQL table: ${tableConfig.mysqlTable}`);

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

        const lotIdToPartNo = new Map(
          fgRows
            .map((row) => [normalizeLotId(row.fgs_lot_id), row.fgs_part_no])
            .filter(([lotId, partNo]) => lotId && partNo)
        );

        const pickRows = await fetchRowsByValues(
          TRACEABILITY_PICK_LOG.mysqlTable,
          TRACEABILITY_PICK_LOG.lotIdColumn,
          lotIds
        );
        totalUpserts += await upsertRowsByLotId(client, TRACEABILITY_PICK_LOG, pickRows, lotIdToMcid);

        const assyTxRowsRaw = await fetchAssyTransactionsByLot(lotIds);
        log.info(`[TRACEABILITY] Fetched ${assyTxRowsRaw.length} AS transaction rows from Postgres .29 for ${lotIds.length} lots.`);

        const assyTxRows = assyTxRowsRaw.filter(row => {
          const lotId = normalizeLotId(row.lot);
          const fgPartNo = lotIdToPartNo.get(lotId);
          return fgPartNo && row.item_code === fgPartNo;
        });

        log.info(`[TRACEABILITY] Filtered AS transaction rows by matching Part Number: ${assyTxRows.length} valid rows remain.`);

        if (assyTxRows.length > 0) {
          log.info(`[TRACEABILITY] 🏭 Sample AS Transactions dari .29 (Top 3):\n${JSON.stringify(assyTxRows.slice(0, 3), null, 2)}`);
        }

        const assyByLot = mapLatestAssyByLot(assyTxRows);
        totalUpserts += await updateAssyFromTransactions(client, lotIdToMcid, assyByLot);
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

const fetchAnchorBatchHistorical = async (targetDb, startDate, endDate, limit = null, lastMcid = null) => {
  const dbPrefix = targetDb ? `${targetDb}.` : '';
  let baseQuery = `
    SELECT mcid FROM (
      SELECT ppl_mc_id AS mcid FROM ${dbPrefix}prod_plc_log_ma WHERE ppl_datetime BETWEEN ? AND ?
      UNION
      SELECT as_mc_id AS mcid FROM ${dbPrefix}prod_assy_lot_print WHERE as_datetime BETWEEN ? AND ?
    ) AS combined
  `;

  const params = [startDate, endDate, startDate, endDate];

  // Resume from cursor: only fetch MCIDs after the last processed one
  if (lastMcid && lastMcid.trim() !== '') {
    baseQuery += ` WHERE mcid > ?`;
    params.push(lastMcid);
  }

  baseQuery += ` ORDER BY mcid ASC`;

  if (limit && limit !== 'Semua') {
    baseQuery += ` LIMIT ?`;
    params.push(parseInt(limit, 10));
  }

  const [rows] = await mysqlPool.query(baseQuery, params);
  return rows.map((row) => normalizeMcid(row.mcid));
};

const checkHistoricalDataCount = async (targetDb, startDate, endDate, reset = false) => {
  const dbPrefix = targetDb ? `${targetDb}.` : '';

  // Build unique worker name to look up progress state
  const startStr = new Date(startDate).toISOString().split('T')[0].replace(/-/g, '');
  const endStr = new Date(endDate).toISOString().split('T')[0].replace(/-/g, '');
  const workerName = `traceability_historical_${targetDb || 'default'}_${startStr}_${endStr}`;

  let lastMcid = null;
  if (!reset) {
    try {
      lastMcid = await getLastMcid(workerName);
    } catch {
      lastMcid = null;
    }
  }

  let countQuery = `
    SELECT COUNT(DISTINCT mcid) as totalCount FROM (
      SELECT ppl_mc_id AS mcid FROM ${dbPrefix}prod_plc_log_ma WHERE ppl_datetime BETWEEN ? AND ?
      UNION
      SELECT as_mc_id AS mcid FROM ${dbPrefix}prod_assy_lot_print WHERE as_datetime BETWEEN ? AND ?
    ) AS combined
  `;
  const params = [startDate, endDate, startDate, endDate];

  if (lastMcid && lastMcid.trim() !== '') {
    countQuery += ` WHERE mcid > ?`;
    params.push(lastMcid);
  }

  const [rows] = await mysqlPool.query(countQuery, params);
  return {
    totalCount: rows[0].totalCount || 0,
    lastMcid: lastMcid || null,
    workerName
  };
};

const syncHistoricalTraceability = async (targetDb, startDate, endDate, limit = null, reset = false) => {
  const startedAt = new Date();

  // Unique worker ID per database + date range for cursor tracking
  const startStr = new Date(startDate).toISOString().split('T')[0].replace(/-/g, '');
  const endStr = new Date(endDate).toISOString().split('T')[0].replace(/-/g, '');
  const workerName = `traceability_historical_${targetDb || 'default'}_${startStr}_${endStr}`;

  let totalUpserts = 0;
  let logId = null;

  try {
    // Reset cursor if user requested a full re-sync from scratch
    if (reset) {
      await resetSyncState(workerName);
    }

    // Read saved cursor to resume from where we left off
    let lastMcid = null;
    try {
      lastMcid = await getLastMcid(workerName);
    } catch {
      lastMcid = null;
    }

    log.info(`[TRACEABILITY_HISTORICAL] Worker: ${workerName} | Resuming from MCID: ${lastMcid || 'beginning'}`);
    const mcids = await fetchAnchorBatchHistorical(targetDb, startDate, endDate, limit, lastMcid);

    if (mcids.length === 0) {
      await writeSyncLog({
        workerName,
        startMcid: 'Hist',
        endMcid: 'Hist',
        totalRows: 0,
        status: 'success',
        errorMessage: null,
        startedAt,
        finishedAt: new Date(),
        productionDateFrom: startDate,
        productionDateTo: endDate
      });
      return { success: true, worker: workerName, totalRows: 0, message: 'No data found in date range' };
    }

    log.info(`[TRACEABILITY_HISTORICAL] Found ${mcids.length} MCIDs to sync for ${targetDb || 'default'} between ${startDate} and ${endDate}`);

    logId = await writeSyncLog({
      workerName,
      startMcid: 'Hist',
      endMcid: 'Hist',
      totalRows: 0,
      status: 'running',
      errorMessage: 'Memulai sinkronisasi...',
      startedAt,
      finishedAt: null,
      productionDateFrom: startDate,
      productionDateTo: endDate
    });

    const mcidChunks = chunkArray(mcids, 500);
    const totalChunks = mcidChunks.length;
    const client = await pgPool.connect();

    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunk = mcidChunks[i];
        await client.query('BEGIN');
        let assyRows = [];

        for (const tableConfig of TRACEABILITY_TABLES) {
          const tableName = targetDb ? `${targetDb}.${tableConfig.mysqlTable}` : tableConfig.mysqlTable;
          const rows = [];
          const batches = chunkArray(chunk, 800);
          for (const batch of batches) {
            const query = `SELECT * FROM ${tableName} WHERE ${tableConfig.mcidColumn} IN (?)`;
            const [batchRows] = await mysqlPool.query(query, [batch]);
            rows.push(...batchRows);
          }
          const upsertedCount = await upsertRows(client, tableConfig, rows);
          totalUpserts += upsertedCount;

          if (tableConfig.mysqlTable === 'prod_assy_lot_print') {
            assyRows = rows;
          }
        }

        const lotIds = Array.from(new Set(assyRows.map((row) => normalizeLotId(row.as_lot_id)).filter(Boolean)));
        if (lotIds.length > 0) {
          const lotIdToMcid = new Map(assyRows.map(row => [normalizeLotId(row.as_lot_id), normalizeMcid(row.as_mc_id)]).filter(([l, m]) => l && m));

          const fgTableName = targetDb ? `${targetDb}.${TRACEABILITY_FG_LOG.mysqlTable}` : TRACEABILITY_FG_LOG.mysqlTable;
          const fgRows = await fetchRowsByValues(fgTableName, TRACEABILITY_FG_LOG.lotIdColumn, lotIds);
          totalUpserts += await upsertRowsByLotId(client, TRACEABILITY_FG_LOG, fgRows, lotIdToMcid);

          const lotIdToPartNo = new Map(fgRows.map(row => [normalizeLotId(row.fgs_lot_id), row.fgs_part_no]).filter(([l, p]) => l && p));

          const pickTableName = targetDb ? `${targetDb}.${TRACEABILITY_PICK_LOG.mysqlTable}` : TRACEABILITY_PICK_LOG.mysqlTable;
          const pickRows = await fetchRowsByValues(pickTableName, TRACEABILITY_PICK_LOG.lotIdColumn, lotIds);
          totalUpserts += await upsertRowsByLotId(client, TRACEABILITY_PICK_LOG, pickRows, lotIdToMcid);

          const assyTxRowsRaw = await fetchAssyTransactionsByLot(lotIds);
          const assyTxRows = assyTxRowsRaw.filter(row => {
            const lotId = normalizeLotId(row.lot);
            const fgPartNo = lotIdToPartNo.get(lotId);
            return fgPartNo && row.item_code === fgPartNo;
          });
          const assyByLot = mapLatestAssyByLot(assyTxRows);
          totalUpserts += await updateAssyFromTransactions(client, lotIdToMcid, assyByLot);
        }
        await client.query('COMMIT');

        // Update progress
        if (logId) {
          const progressPercentage = Math.round(((i + 1) / totalChunks) * 100);
          const progressMsg = `Memproses: ${progressPercentage}% (Bagian ${i + 1} dari ${totalChunks})`;
          await updateSyncLogProgress(logId, totalUpserts, 'running', progressMsg);
        }
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Save cursor position so the next run can resume from here
    const finalMcid = mcids[mcids.length - 1];
    await updateSyncSuccess(workerName, finalMcid);
    log.info(`[TRACEABILITY_HISTORICAL] ✅ Done. Saved cursor at MCID: ${finalMcid}`);

    if (logId) {
      await updateSyncLogProgress(logId, totalUpserts, 'success', null, new Date());
    } else {
      await writeSyncLog({
        workerName,
        startMcid: mcids[0] || 'Hist',
        endMcid: finalMcid || 'Hist',
        totalRows: totalUpserts,
        status: 'success',
        errorMessage: null,
        startedAt,
        finishedAt: new Date(),
        productionDateFrom: startDate,
        productionDateTo: endDate
      });
    }

    return { success: true, worker: workerName, totalRows: totalUpserts };
  } catch (error) {
    if (logId) {
      await updateSyncLogProgress(logId, totalUpserts, 'failed', error.message, new Date());
    } else {
      await writeSyncLog({
        workerName,
        startMcid: 'Hist',
        endMcid: 'Hist',
        totalRows: totalUpserts,
        status: 'failed',
        errorMessage: error.message,
        startedAt,
        finishedAt: new Date(),
        productionDateFrom: startDate,
        productionDateTo: endDate
      });
    }
    log.error('Historical sync failed', error);
    return { success: false, worker: workerName, error: error.message };
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
  syncTraceabilityInitial,
  syncHistoricalTraceability,
  checkHistoricalDataCount
};
