-- ========================================
-- MySQL Reference: Source Table Structure
-- ========================================
-- Database: adsmin_inventory
-- Table: inventory_stock
-- ========================================
-- This file is for reference only - DO NOT RUN on MySQL
-- The source table should already exist
-- ========================================

/*
CREATE TABLE IF NOT EXISTS inventory_stock (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    whs_code VARCHAR(100),
    area VARCHAR(20),
    part_number VARCHAR(50),
    wo FLOAT,
    stock_qc_hold INT,
    stock_in_day DECIMAL(30,1),
    qty INT,
    status_stock INT,
    date_in VARCHAR(30),
    date_out VARCHAR(30),
    INDEX idx_id (id),
    INDEX idx_whs_code (whs_code),
    INDEX idx_part_number (part_number)
);
*/

-- Query to check source data:
-- SELECT * FROM inventory_stock ORDER BY id DESC LIMIT 10;

-- Query to get max ID:
-- SELECT MAX(id) AS max_id FROM inventory_stock;

-- Query to count records:
-- SELECT COUNT(*) AS total_records FROM inventory_stock;
