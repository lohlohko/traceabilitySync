-- ========================================
-- DROP UNIQUE Constraint dari inventory_stocks
-- ========================================
-- Karena kita mau ALLOW multiple rows dengan kombinasi sama
-- (warehouse_area_id + item_id yang sama boleh banyak row)
-- ========================================

-- Drop UNIQUE constraint
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'inventory_stocks_warehouse_area_item_unique'
    ) THEN
        ALTER TABLE inventory_stocks
        DROP CONSTRAINT inventory_stocks_warehouse_area_item_unique;
        
        RAISE NOTICE '✅ UNIQUE constraint DROPPED successfully';
        RAISE NOTICE 'ℹ️  Now you can INSERT multiple rows with same warehouse_area_id + item_id';
    ELSE
        RAISE NOTICE 'ℹ️  UNIQUE constraint does not exist (already dropped or never existed)';
    END IF;
END $$;

-- Verify constraint was dropped
SELECT 
    con.conname AS constraint_name,
    con.contype AS constraint_type
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'inventory_stocks'
  AND con.conname = 'inventory_stocks_warehouse_area_item_unique';

-- Should return empty (no rows) if dropped successfully
