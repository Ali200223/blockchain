-- 012_trade_fills_ledger_pointers.sql
-- Adds ledger pointer columns + indexes for trade_fills
-- Fully idempotent, safe to re-run, and requires no SYSTEM_USER privilege.

-- ledger_block_height
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND COLUMN_NAME = 'ledger_block_height'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE trade_fills ADD COLUMN ledger_block_height BIGINT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ledger_block_hash
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND COLUMN_NAME = 'ledger_block_hash'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE trade_fills ADD COLUMN ledger_block_hash VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ledger_commit_key
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND COLUMN_NAME = 'ledger_commit_key'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE trade_fills ADD COLUMN ledger_commit_key VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ledger_item_idx
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND COLUMN_NAME = 'ledger_item_idx'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE trade_fills ADD COLUMN ledger_item_idx INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ledger_committed_at
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND COLUMN_NAME = 'ledger_committed_at'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE trade_fills ADD COLUMN ledger_committed_at TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- index idx_trade_ledger_height
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND INDEX_NAME = 'idx_trade_ledger_height'
);
SET @sql := IF(@exists = 0,
  'CREATE INDEX idx_trade_ledger_height ON trade_fills (ledger_block_height)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- index idx_trade_ledger_commit
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trade_fills'
    AND INDEX_NAME = 'idx_trade_ledger_commit'
);
SET @sql := IF(@exists = 0,
  'CREATE INDEX idx_trade_ledger_commit ON trade_fills (ledger_commit_key)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
