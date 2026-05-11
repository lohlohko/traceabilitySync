const { mysqlPool } = require('../config/mysql');
const { pgPool } = require('../config/postgres');
const log = require('../utils/logger');
const {
  getLastSyncId,
  updateSyncSuccess,
  updateSyncFailure,
  setSyncRunning
} = require('./syncState.service');

const SYNC_NAME = 'inventory_stock';
const BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE) || 5;

const isAlreadySynced = async (sourceId, client) => {
  try {
    const query = `
      SELECT id FROM sync_records
      WHERE sync_name = $1 AND source_id = $2
      LIMIT 1
    `;
    
    const result = await client.query(query, [SYNC_NAME, sourceId]);
    return result.rows.length > 0;
  } catch (error) {
    log.error(`Failed to check sync_records for source_id: ${sourceId}`, error);
    return false;
  }
};

const recordSynced = async (sourceId, whsCode, category, partNumberCustomer, client) => {
  try {
    const query = `
      INSERT INTO sync_records (sync_name, source_id, whs_code, category, part_number_customer, synced_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (sync_name, source_id) DO UPDATE
      SET whs_code = $3, category = $4, part_number_customer = $5, synced_at = NOW()
    `;
    
    await client.query(query, [SYNC_NAME, sourceId, whsCode, category, partNumberCustomer]);
  } catch (error) {
    log.error(`Failed to record sync for source_id: ${sourceId}`, error);
  }
};

const getWarehouseAreaId = async (whsCode, client) => {
  try {
    const query = `
      SELECT wa.id 
      FROM warehouse_area wa
      JOIN warehouses w ON wa.warehouse_id = w.id
      WHERE w.code = $1
      LIMIT 1
    `;
    
    const result = await client.query(query, [whsCode]);
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    log.error(`Failed to get warehouse_area_id for code: ${whsCode}`, error);
    return null;
  }
};

const getItemId = async (partNumberCustomer, client) => {
  try {
    const query = `
      SELECT id 
      FROM items 
      WHERE item_code_external = $1
      LIMIT 1
    `;
    
    const result = await client.query(query, [partNumberCustomer]);
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    log.error(`Failed to get item_id for part_number_customer: ${partNumberCustomer}`, error);
    return null;
  }
};

const parseDate = (dateStr) => {
  if (!dateStr || dateStr === '' || dateStr === '0000-00-00' || dateStr === '0000-00-00 00:00:00') {
    return null;
  }
  
  try {
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

// ============================================
// INITIAL SYNC: Fetch filtered data in batches
// Filter: whs_code='WH-FG' AND category='FG'
// ============================================
const fetchAllDataFromMySQL = async (offset) => {
  try {
    const query = `
      SELECT *
      FROM inventory_stock
      WHERE whs_code = 'WH-FG'
      AND category = 'FG'
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `;
    
    const [rows] = await mysqlPool.query(query, [BATCH_SIZE, offset]);
    return rows;
  } catch (error) {
    log.error('Failed to fetch filtered data from MySQL', error);
    throw error;
  }
};

// ============================================
// ONGOING SYNC: Fetch filtered data for comparison
// Filter: whs_code='WH-FG' AND category='FG'
// ============================================
const fetchFilteredDataFromMySQL = async (offset) => {
  try {
    const query = `
      SELECT *
      FROM inventory_stock
      WHERE whs_code = 'WH-FG'
      AND category = 'FG'
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `;
    
    const [rows] = await mysqlPool.query(query, [BATCH_SIZE, offset]);
    return rows;
  } catch (error) {
    log.error('Failed to fetch filtered data from MySQL', error);
    throw error;
  }
};

// ============================================
// INITIAL SYNC: Insert only (for first-time)
// ============================================
const insertToPostgreSQL = async (data, client) => {
  try {
    const alreadySynced = await isAlreadySynced(data.id, client);
    if (alreadySynced) {
      return false; // Already synced, skip
    }
    
    const warehouseAreaId = await getWarehouseAreaId(data.whs_code, client);
    const itemId = await getItemId(data.part_number_customer, client);
    
    if (!warehouseAreaId) {
      log.warn(`❌ Warehouse not found: ${data.whs_code} | MySQL ID: ${data.id} | Part: ${data.part_number_customer}`);
      return false;
    }
    
    if (!itemId) {
      log.warn(`❌ Item not found -> Part Number Customer:${data.part_number_customer} | MySQL ID: ${data.id} | WHS: ${data.whs_code}`);
      return false;
    }
    
    const insertQuery = `
      INSERT INTO inventory_stocks (
        warehouse_area_id,
        item_id,
        wo,
        qty_qc_hold,
        stock_in_day,
        qty,
        status_stock,
        date_in,
        date_out,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    `;
    
    const values = [
      warehouseAreaId,
      itemId,
      data.wo || 0,
      data.stock_qc_hold || 0,
      data.stock_in_day || 0,
      data.qty || 0,
      data.status_stock || 0,
      parseDate(data.date_in),
      parseDate(data.date_out)
    ];
    
    await client.query(insertQuery, values);
    await recordSynced(data.id, data.whs_code, data.category, data.part_number_customer, client);
    
    log.info(`✅ [INITIAL] MySQL ID: ${data.id} | ${data.whs_code} | ${data.part_number_customer}`);
    return true;
  } catch (error) {
    log.error(`Failed to insert data ID: ${data.id}`, error);
    throw error;
  }
};

// ============================================
// ONGOING SYNC: Compare and update if changed
// ============================================
const compareAndUpdate = async (mysqlData, client) => {
  try {
    const warehouseAreaId = await getWarehouseAreaId(mysqlData.whs_code, client);
    const itemId = await getItemId(mysqlData.part_number_customer, client);
    
    if (!warehouseAreaId) {
      log.warn(`❌ Warehouse not found: ${mysqlData.whs_code} | MySQL ID: ${mysqlData.id}| Part: ${mysqlData.part_number_customer}`);
      return false;
    }
    
    if (!itemId) {
      log.warn(`❌ Item not found -> Part Number Customer:${mysqlData.part_number_customer} | MySQL ID: ${mysqlData.id} | WHS: ${mysqlData.whs_code}`);
      return false;
    }
    
    // Find existing record in PostgreSQL
    const findQuery = `
      SELECT id, wo, qty_qc_hold, stock_in_day, qty, status_stock, 
             date_in, date_out
      FROM inventory_stocks
      WHERE warehouse_area_id = $1 AND item_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    const result = await client.query(findQuery, [warehouseAreaId, itemId]);
    
    if (result.rows.length === 0) {
      // Record doesn't exist, insert new
      const insertQuery = `
        INSERT INTO inventory_stocks (
          warehouse_area_id, item_id, wo, qty_qc_hold, stock_in_day,
          qty, status_stock, date_in, date_out, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      `;
      
      await client.query(insertQuery, [
        warehouseAreaId, itemId, mysqlData.wo || 0, mysqlData.stock_qc_hold || 0,
        mysqlData.stock_in_day || 0, mysqlData.qty || 0, mysqlData.status_stock || 0,
        parseDate(mysqlData.date_in), parseDate(mysqlData.date_out)
      ]);
      
      // Track in sync_records for worker sync
      await recordSynced(mysqlData.id, mysqlData.whs_code, mysqlData.category, mysqlData.part_number_customer, client);
      
      log.info(`✅ [NEW] Inserted ${mysqlData.whs_code} | ${mysqlData.part_number_customer}`);
      return true;
    }
    
    // Compare values
    const pgData = result.rows[0];
    const hasChanges = 
      (mysqlData.wo || 0) !== (pgData.wo || 0) ||
      (mysqlData.stock_qc_hold || 0) !== (pgData.qty_qc_hold || 0) ||
      (mysqlData.stock_in_day || 0) !== (pgData.stock_in_day || 0) ||
      (mysqlData.qty || 0) !== (pgData.qty || 0) ||
      (mysqlData.status_stock || 0) !== (pgData.status_stock || 0);
    
    if (!hasChanges) {
      return false; // No changes, skip
    }
    
    // Update existing record
    const updateQuery = `
      UPDATE inventory_stocks
      SET wo = $1, qty_qc_hold = $2, stock_in_day = $3, qty = $4,
          status_stock = $5, date_in = $6, date_out = $7, updated_at = NOW()
      WHERE id = $8
    `;
    
    await client.query(updateQuery, [
      mysqlData.wo || 0, mysqlData.stock_qc_hold || 0, mysqlData.stock_in_day || 0,
      mysqlData.qty || 0, mysqlData.status_stock || 0, parseDate(mysqlData.date_in),
      parseDate(mysqlData.date_out), pgData.id
    ]);
    
    // Track in sync_records for worker sync
    await recordSynced(mysqlData.id, mysqlData.whs_code, mysqlData.category, mysqlData.part_number_customer, client);
    
    log.info(`🔄 [UPDATE] PG ID: ${pgData.id} | ${mysqlData.whs_code} | ${mysqlData.part_number_customer}`);
    return true;
  } catch (error) {
    log.error(`Failed to compare/update MySQL ID: ${mysqlData.id}`, error);
    throw error;
  }
};

// ============================================
// INITIAL SYNC: Sync filtered data from MySQL
// Filter: whs_code='WH-FG' AND category='FG'
// ============================================
const runInitialSync = async () => {
  const startTime = Date.now();
  log.sync('==========================================');
  log.sync('🚀 STARTING INITIAL SYNC (WH-FG + FG)...');
  
  let connection = null;
  let totalSynced = 0;
  let totalSkipped = 0;
  let offset = 0;
  let batchCount = 0;
  
  try {
    connection = await pgPool.connect();
    
    while (true) {
      batchCount++;
      log.info(`📦 Batch #${batchCount} (offset: ${offset})...`);
      
      const data = await fetchAllDataFromMySQL(offset);
      
      if (data.length === 0) {
        log.info('✅ No more data');
        break;
      }
      
      let batchSuccess = 0;
      let batchSkipped = 0;
      
      for (const record of data) {
        try {
          const success = await insertToPostgreSQL(record, connection);
          if (success) batchSuccess++;
          else batchSkipped++;
        } catch (error) {
          log.error(`Error: MySQL ID ${record.id}`, error);
          batchSkipped++;
        }
      }
      
      totalSynced += batchSuccess;
      totalSkipped += batchSkipped;
      offset += BATCH_SIZE;
      
      log.info(`Batch #${batchCount}: ✅ ${batchSuccess} | ⏭️  ${batchSkipped}`);
      
      if (data.length < BATCH_SIZE) {
        break;
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log.success(`✅ INITIAL SYNC DONE in ${duration}s`);
    log.info(`Total: ${totalSynced} synced | ${totalSkipped} skipped | ${batchCount} batches`);
    log.sync('==========================================\n');
    
    return { success: true, synced: totalSynced, skipped: totalSkipped };
  } catch (error) {
    log.error('Initial sync failed', error);
    log.sync('==========================================\n');
    return { success: false, error: error.message };
  } finally {
    if (connection) connection.release();
  }
};

// ============================================
// ONGOING SYNC: Compare filtered data (WH-FG + FG)
// ============================================
const syncInventoryStock = async () => {
  const startTime = Date.now();
  log.sync('==========================================');
  log.sync('🔄 Ongoing sync (WH-FG + FG)...');
  
  let connection = null;
  let updatedCount = 0;
  let unchangedCount = 0;
  let offset = 0;
  
  try {
    await setSyncRunning(SYNC_NAME);
    connection = await pgPool.connect();
    
    while (true) {
      const data = await fetchFilteredDataFromMySQL(offset);
      
      if (data.length === 0) {
        break;
      }
      
      for (const record of data) {
        try {
          const updated = await compareAndUpdate(record, connection);
          if (updated) updatedCount++;
          else unchangedCount++;
        } catch (error) {
          log.error(`Error: MySQL ID ${record.id}`, error);
          unchangedCount++;
        }
      }
      
      offset += BATCH_SIZE;
      
      if (data.length < BATCH_SIZE) {
        break;
      }
    }
    
    await updateSyncSuccess(SYNC_NAME, 0, updatedCount);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log.success(`✅ Sync done in ${duration}s`);
    log.info(`Updated: ${updatedCount} | Unchanged: ${unchangedCount}`);
    log.sync('==========================================\n');
    
    return { success: true, synced: updatedCount, skipped: unchangedCount };
  } catch (error) {
    log.error('Sync failed', error);
    await updateSyncFailure(SYNC_NAME, error.message);
    log.sync('==========================================\n');
    return { success: false, error: error.message };
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  runInitialSync,
  syncInventoryStock
};
