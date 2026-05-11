-- ============================================
-- Apply All Column Type Fixes
-- Match PostgreSQL columns with MySQL types
-- ============================================

-- stock_in_day: decimal(30,1)
ALTER TABLE inventory_stocks 
ALTER COLUMN stock_in_day TYPE NUMERIC(30,1);

-- qty_qc_hold: might also be decimal in MySQL
ALTER TABLE inventory_stocks 
ALTER COLUMN qty_qc_hold TYPE NUMERIC(30,1);

-- qty: might also be decimal in MySQL
ALTER TABLE inventory_stocks 
ALTER COLUMN qty TYPE NUMERIC(30,1);

-- wo: might also be decimal in MySQL
ALTER TABLE inventory_stocks 
ALTER COLUMN wo TYPE NUMERIC(30,1);

COMMENT ON COLUMN inventory_stocks.stock_in_day IS 'Decimal(30,1) - matches MySQL';
COMMENT ON COLUMN inventory_stocks.qty_qc_hold IS 'Decimal(30,1) - matches MySQL';
COMMENT ON COLUMN inventory_stocks.qty IS 'Decimal(30,1) - matches MySQL';
COMMENT ON COLUMN inventory_stocks.wo IS 'Decimal(30,1) - matches MySQL';
