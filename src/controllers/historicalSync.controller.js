const { syncHistoricalTraceability, checkHistoricalDataCount } = require('../services/traceabilitySync.service');
const { pauseSyncScheduler, resumeSyncScheduler } = require('../schedulers/syncScheduler');
const { pgPool } = require('../config/postgres');

/**
 * Check historical sync data count
 */
const checkHistoricalCount = async (req, res) => {
  const { targetDatabase, startDate, endDate, reset } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  try {
    const result = await checkHistoricalDataCount(
      targetDatabase || 'b_production',
      start,
      end,
      Boolean(reset)
    );
    return res.status(200).json({
      success: true,
      data: result  // { totalCount, lastMcid, workerName }
    });
  } catch (error) {
    console.error('Check historical count error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Trigger historical sync as a background job
 */
const runHistoricalSync = async (req, res) => {
  const { targetDatabase, startDate, endDate, limit, reset } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: 'startDate and endDate are required'
    });
  }

  // Validate dates
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({
      success: false,
      message: 'Invalid date format'
    });
  }

  // Set time limits (00:00:00 to 23:59:59)
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  // Pause the automatic scheduler so we don't overload the DB
  pauseSyncScheduler();

  // Run in background, do not await, but resume scheduler when done
  syncHistoricalTraceability(targetDatabase || 'b_production', start, end, limit, Boolean(reset))
    .catch(error => {
      console.error('Background historical sync error:', error);
    })
    .finally(() => {
      resumeSyncScheduler();
    });

  return res.status(202).json({
    success: true,
    message: 'Historical sync job has been started in the background',
    details: {
      targetDatabase: targetDatabase || 'b_production',
      startDate: start,
      endDate: end,
      limit: limit || 'Semua'
    }
  });
};

module.exports = {
  checkHistoricalCount,
  runHistoricalSync
};
