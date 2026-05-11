-- ============================================
-- Alter stock_in_day column to DECIMAL(30,1)
-- Reason: MySQL uses decimal(30,1), PostgreSQL was integer
-- ============================================

ALTER TABLE inventory_stocks 
ALTER COLUMN stock_in_day TYPE NUMERIC(30,1);

-- Comment to track the change
COMMENT ON COLUMN inventory_stocks.stock_in_day IS 'Stock in day - decimal(30,1) to match MySQL';
