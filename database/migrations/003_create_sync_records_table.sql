-- ========================================
-- PostgreSQL: Table untuk Track MySQL IDs yang Sudah Di-sync
-- ========================================
-- Database: advics_system
-- Purpose: Mencegah duplikasi data dari MySQL dengan ID yang sama
-- ========================================

-- Create sync_records table
CREATE TABLE IF NOT EXISTS sync_records (
    id BIGSERIAL PRIMARY KEY,
    sync_name VARCHAR(100) NOT NULL,
    source_id BIGINT NOT NULL,
    synced_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT sync_records_unique UNIQUE (sync_name, source_id)
);

-- Create index untuk performa cek cepat
CREATE INDEX IF NOT EXISTS idx_sync_records_sync_name_source_id 
ON sync_records(sync_name, source_id);

CREATE INDEX IF NOT EXISTS idx_sync_records_synced_at 
ON sync_records(synced_at);

-- Verify table created
SELECT 
    tablename, 
    schemaname 
FROM pg_tables 
WHERE tablename = 'sync_records';

-- Show table structure
\d sync_records;

COMMENT ON TABLE sync_records IS 'Tracks MySQL source IDs that have been synced to prevent duplicate inserts';
COMMENT ON COLUMN sync_records.sync_name IS 'Name of sync process (e.g., inventory_stock)';
COMMENT ON COLUMN sync_records.source_id IS 'MySQL table ID that has been synced';
COMMENT ON COLUMN sync_records.synced_at IS 'When this record was synced';
