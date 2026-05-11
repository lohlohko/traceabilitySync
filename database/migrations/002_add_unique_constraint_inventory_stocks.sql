-- ========================================
-- PostgreSQL Migration: Inventory Stocks Table
-- ========================================
-- Database: advics_system
-- Purpose: Add UNIQUE constraint for upsert operations
-- ========================================

-- Add UNIQUE constraint on (warehouse_area_id, item_id) if not exists
-- This allows ON CONFLICT (warehouse_area_id, item_id) DO UPDATE

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'inventory_stocks_warehouse_area_item_unique'
    ) THEN
        ALTER TABLE inventory_stocks
        ADD CONSTRAINT inventory_stocks_warehouse_area_item_unique 
        UNIQUE (warehouse_area_id, item_id);
        
        RAISE NOTICE 'UNIQUE constraint added successfully';
    ELSE
        RAISE NOTICE 'UNIQUE constraint already exists';
    END IF;
END $$;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_inventory_stocks_warehouse_area_id 
ON inventory_stocks(warehouse_area_id);

CREATE INDEX IF NOT EXISTS idx_inventory_stocks_item_id 
ON inventory_stocks(item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_stocks_created_at 
ON inventory_stocks(created_at);

CREATE INDEX IF NOT EXISTS idx_inventory_stocks_updated_at 
ON inventory_stocks(updated_at);

-- Display table structure
\d inventory_stocks;
