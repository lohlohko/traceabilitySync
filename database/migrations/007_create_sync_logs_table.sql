-- ========================================
-- PostgreSQL Migration: Sync Logs Table
-- ========================================
-- Purpose: Track each sync run (success or failure)
-- ========================================

CREATE TABLE IF NOT EXISTS sync_logs (
    id BIGSERIAL PRIMARY KEY,
    worker_name VARCHAR(255) NOT NULL,
    start_mcid VARCHAR(32),
    end_mcid VARCHAR(32),
    total_rows INT DEFAULT 0,
    status VARCHAR(50),
    error_message TEXT,
    started_at TIMESTAMP,
    finished_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_worker_name
ON sync_logs(worker_name);

CREATE INDEX IF NOT EXISTS idx_sync_logs_started_at
ON sync_logs(started_at);
