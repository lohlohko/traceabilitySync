const express = require('express');
const router = express.Router();
const { runSyncNow, runInitialSyncNow, getSchedulerStatus } = require('../schedulers/syncScheduler');
const { getSyncStatuses } = require('../services/syncState.service');
const { getTraceabilityWorkerNames } = require('../services/traceabilitySync.service');
const { runHistoricalSync, checkHistoricalCount } = require('../controllers/historicalSync.controller');

/**
 * GET /api/sync/status - Get sync status
 */
router.get('/status', async (req, res) => {
  try {
    const schedulerStatus = getSchedulerStatus();
    const workerNames = getTraceabilityWorkerNames();
    const syncStates = await getSyncStatuses(workerNames);
    
    res.json({
      success: true,
      data: {
        scheduler: schedulerStatus,
        lastSync: syncStates
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/sync/run - Trigger manual sync
 */
router.post('/run', async (req, res) => {
  try {
    const result = await runSyncNow();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Sync completed successfully',
        data: result
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Sync failed',
        error: result.error || result.message
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/sync/initial - Reset cursor and run full sync
 */
router.post('/initial', async (req, res) => {
  try {
    const result = await runInitialSyncNow();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Initial sync completed',
        data: result
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Initial sync failed',
        error: result.error
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/historical/check', checkHistoricalCount);

router.post('/historical', runHistoricalSync);

module.exports = router;
