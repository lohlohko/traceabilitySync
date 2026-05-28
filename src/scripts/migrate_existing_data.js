const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { mysqlPool } = require('../config/mysql');
const { pgPool } = require('../config/postgres');

const BATCH_SIZE = 2000;

function parseDate(dateValue) {
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
}

function normalizeLotId(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim().replace(/\0/g, '');
}

async function runMigration() {
  const startTime = Date.now();
  console.log('Starting data migration for assembly and final tester...');

  // Step 1: Fetch all records from Postgres that might need fixing.
  console.log('Step 1: Fetching records from Postgres...');
  let records = [];
  try {
    const result = await pgPool.query(`
      SELECT mcid, as_lot
      FROM traceability_report
      WHERE mcid IS NOT NULL AND mcid <> ''
      ORDER BY id ASC
    `);
    records = result.rows;
    console.log(`Fetched ${records.length} records to process.`);
  } catch (err) {
    console.error('Error fetching records from Postgres:', err.message);
    process.exit(1);
  }

  if (records.length === 0) {
    console.log('No records to update. Migration complete.');
    process.exit(0);
  }

  // Step 2: Process in batches
  console.log('Step 2: Updating assembly, final tester, and fi_datetime columns in batches...');
  const totalRecords = records.length;
  let processedCount = 0;
  let updatedCount = 0;

  for (let i = 0; i < totalRecords; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    const mcids = chunk.map(r => r.mcid).filter(Boolean);

    if (mcids.length === 0) {
      processedCount += chunk.length;
      continue;
    }

    // 1. Fetch from MySQL prod_assy_lot_print (for Final Tester data & Lot ID) using mcids
    let assyPrintRows = [];
    try {
      const [rows] = await mysqlPool.query(
        'SELECT as_mc_id, as_lot_id, as_line_area, as_datetime FROM prod_assy_lot_print WHERE as_mc_id IN (?)',
        [mcids]
      );
      assyPrintRows = rows;
    } catch (err) {
      console.error(`Error querying MySQL prod_assy_lot_print at batch ${i}:`, err.message);
      process.exit(1);
    }

    // Map by as_mc_id
    const assyPrintMap = new Map();
    for (const row of assyPrintRows) {
      const mcid = String(row.as_mc_id).trim();
      assyPrintMap.set(mcid, {
        as_lot_id: normalizeLotId(row.as_lot_id),
        as_line_area: row.as_line_area,
        as_datetime: parseDate(row.as_datetime)
      });
    }

    // 2. Fetch Assembly data from MySQL prod_fg_log using lotIds.
    const lotIdsSet = new Set();
    for (const record of chunk) {
      if (record.as_lot) {
        lotIdsSet.add(normalizeLotId(record.as_lot));
      }
      const printRow = assyPrintMap.get(record.mcid);
      if (printRow && printRow.as_lot_id) {
        lotIdsSet.add(printRow.as_lot_id);
      }
    }
    const lotIds = Array.from(lotIdsSet).filter(Boolean);

    let fgRows = [];
    if (lotIds.length > 0) {
      try {
        const [rows] = await mysqlPool.query(
          'SELECT fgs_lot_id, fgs_area, fgs_datetime FROM prod_fg_log WHERE fgs_lot_id IN (?)',
          [lotIds]
        );
        fgRows = rows;
      } catch (err) {
        console.error(`Error querying MySQL prod_fg_log at batch ${i}:`, err.message);
        process.exit(1);
      }
    }

    const fgMap = new Map();
    for (const row of fgRows) {
      const lotId = normalizeLotId(row.fgs_lot_id);
      fgMap.set(lotId, {
        fgs_area: row.fgs_area,
        fgs_datetime: parseDate(row.fgs_datetime)
      });
    }

    // 3. Fetch Final Inspection datetime from MySQL prod_plc_log_fi using mcids
    let fiRows = [];
    try {
      const [rows] = await mysqlPool.query(
        'SELECT ppl_mc_id, ppl_datetime FROM prod_plc_log_fi WHERE ppl_mc_id IN (?)',
        [mcids]
      );
      fiRows = rows;
    } catch (err) {
      console.error(`Error querying MySQL prod_plc_log_fi at batch ${i}:`, err.message);
      process.exit(1);
    }

    const fiMap = new Map();
    for (const row of fiRows) {
      const mcid = String(row.ppl_mc_id).trim();
      const dt = parseDate(row.ppl_datetime);
      if (dt) {
        const existing = fiMap.get(mcid);
        if (!existing || dt > existing) {
          fiMap.set(mcid, dt);
        }
      }
    }

    // 4. Build bulk update values for Postgres
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const record of chunk) {
      const printRow = assyPrintMap.get(record.mcid);
      
      // Determine the final correct Lot ID
      const finalLot = printRow ? printRow.as_lot_id : (record.as_lot ? normalizeLotId(record.as_lot) : null);
      
      // Final Tester (from prod_assy_lot_print)
      const ftLine = printRow ? printRow.as_line_area : null;
      const ftDatetime = printRow ? printRow.as_datetime : null;

      // Assembly (from prod_fg_log using the correct lot ID)
      const fgRow = finalLot ? fgMap.get(finalLot) : null;
      const asLine = fgRow ? fgRow.fgs_area : null;
      const asDatetime = fgRow ? fgRow.fgs_datetime : null;

      // Final Inspection (from prod_plc_log_fi)
      const fiDatetime = fiMap.get(record.mcid) || null;

      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}::timestamp, $${paramIndex + 4}, $${paramIndex + 5}::timestamp, $${paramIndex + 6}::timestamp)`);
      values.push(record.mcid, finalLot, ftLine, ftDatetime, asLine, asDatetime, fiDatetime);
      paramIndex += 7;
    }

    if (values.length > 0) {
      const query = `
        UPDATE traceability_report AS r
        SET
          as_lot = v.as_lot,
          ft_line = v.ft_line,
          ft_datetime = v.ft_datetime,
          as_line = v.as_line,
          as_datetime = v.as_datetime,
          fi_datetime = v.fi_datetime
        FROM (VALUES ${placeholders.join(', ')}) AS v(mcid, as_lot, ft_line, ft_datetime, as_line, as_datetime, fi_datetime)
        WHERE r.mcid = v.mcid
      `;

      try {
        const pgRes = await pgPool.query(query, values);
        updatedCount += pgRes.rowCount;
      } catch (err) {
        console.error(`Error updating Postgres at batch ${i}:`, err.message);
        process.exit(1);
      }
    }

    processedCount += chunk.length;
    const pct = ((processedCount / totalRecords) * 100).toFixed(1);
    console.log(`Processed ${processedCount}/${totalRecords} (${pct}%) | Updated ${updatedCount} rows...`);
  }

  console.log(`Migration finished successfully in ${((Date.now() - startTime) / 1000).toFixed(2)}s.`);
  console.log(`Total processed: ${processedCount}, Total updated in Postgres: ${updatedCount}`);
  process.exit(0);
}

runMigration().catch(err => {
  console.error('Unhandled error during migration:', err);
  process.exit(1);
});
