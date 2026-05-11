-- ============================================
-- Add tracking columns to sync_records
-- Purpose: Track which whs_code and category synced
-- ============================================

ALTER TABLE sync_records 
ADD COLUMN whs_code VARCHAR(50),
ADD COLUMN category VARCHAR(50),
ADD COLUMN part_number VARCHAR(100);

-- Add index for filtering
CREATE INDEX idx_sync_records_whs_category ON sync_records(whs_code, category);

COMMENT ON COLUMN sync_records.whs_code IS 'Warehouse code from MySQL';
COMMENT ON COLUMN sync_records.category IS 'Category from MySQL';
COMMENT ON COLUMN sync_records.part_number IS 'Part number from MySQL';
