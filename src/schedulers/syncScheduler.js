const cron = require('node-cron');
const {
  syncTraceability,
  syncTraceabilityInitial
} = require('../services/traceabilitySync.service');
const log = require('../utils/logger');

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 2;


const cronExpression = `*/${SYNC_INTERVAL_MINUTES} * * * *`;

let syncJob = null;
let isRunning = false;

const startSyncScheduler = () => {
  log.info(`🕐 Starting sync scheduler: every ${SYNC_INTERVAL_MINUTES} minutes`);
  log.info(`📅 Cron expression: ${cronExpression}`);
  
  syncJob = cron.schedule(cronExpression, async () => {
    if (isRunning) {
      log.warn('Previous sync still running, skipping this cycle');
      return;
    }
    
    isRunning = true;
    try {
      await syncTraceability();
    } catch (error) {
      log.error('Sync job error', error);
    } finally {
      isRunning = false;
    }
  });
  
  log.success('✅ Sync scheduler started successfully');
};

const stopSyncScheduler = () => {
  if (syncJob) {
    syncJob.stop();
    log.info('Sync scheduler stopped');
  }
};

const runSyncNow = async () => {
  if (isRunning) {
    log.warn('Sync is already running');
    return { success: false, message: 'Sync is already running' };
  }
  
  isRunning = true;
  try {
    const result = await syncTraceability();
    return result;
  } catch (error) {
    log.error('Manual sync failed', error);
    return { success: false, error: error.message };
  } finally {
    isRunning = false;
  }
};

const runInitialSyncNow = async () => {
  if (isRunning) {
    log.warn('Sync is already running');
    return { success: false, message: 'Sync is already running' };
  }

  isRunning = true;
  try {
    const result = await syncTraceabilityInitial();
    return result;
  } catch (error) {
    log.error('Manual initial sync failed', error);
    return { success: false, error: error.message };
  } finally {
    isRunning = false;
  }
};

const getSchedulerStatus = () => {
  return {
    isRunning: isRunning,
    isScheduled: syncJob !== null,
    intervalMinutes: SYNC_INTERVAL_MINUTES,
    cronExpression: cronExpression
  };
};

module.exports = {
  startSyncScheduler,
  stopSyncScheduler,
  runSyncNow,
  runInitialSyncNow,
  getSchedulerStatus
};
