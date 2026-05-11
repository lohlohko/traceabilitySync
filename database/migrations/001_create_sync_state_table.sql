-- ========================================
-- PostgreSQL Migration: Sync State Table
-- ========================================
-- Database: advics_system
-- Purpose: Track synchronization state for incremental sync
-- ========================================

-- Create sync_state table
CREATE TABLE IF NOT EXISTS sync_state (
    id BIGSERIAL PRIMARY KEY,
    worker_name VARCHAR(255) UNIQUE NOT NULL,
    last_mcid VARCHAR(32) NOT NULL DEFAULT '',
    last_sync_at TIMESTAMP,
    status VARCHAR(50) DEFAULT 'idle',  -- idle, running, success, failed
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create index on worker_name for faster lookups
CREATE INDEX IF NOT EXISTS idx_sync_state_worker_name ON sync_state(worker_name);

-- Create index on status for monitoring
CREATE INDEX IF NOT EXISTS idx_sync_state_status ON sync_state(status);

-- Insert initial sync state (example)
INSERT INTO sync_state (worker_name, last_mcid, status)
VALUES ('plc_ma', '', 'idle')
ON CONFLICT (worker_name) DO NOTHING;

-- Display sync_state table
SELECT * FROM sync_state;
