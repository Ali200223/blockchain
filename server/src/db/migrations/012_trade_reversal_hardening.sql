-- 013_trade_reversal_hardening.sql
-- MySQL 5.7/8.0 compatible (no IF NOT EXISTS in ALTER/INDEX)

SET @db := DATABASE();

-- -------------------------
-- 1) Columns (idempotent)
-- -------------------------

-- status (add if missing)
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=@db AND table_name='trade_fills' AND column_name='status') = 0,
    "ALTER TABLE trade_fills ADD COLUMN status ENUM('CONFIRMED','REVERSED') NOT NULL DEFAULT 'CONFIRMED'",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- If status exists and is ENUM containing CONFIRMED but not REVERSED, extend it safely
SET @status_type := (
  SELECT column_type
  FROM information_schema.columns
  WHERE table_schema=@db AND table_name='trade_fills' AND column_name='status'
  LIMIT 1
);

SET @sql := (
  SELECT IF(
    @status_type IS NULL,
    "SELECT 1",
    IF(
      LOWER(@status_type) NOT LIKE "enum(%" OR @status_type NOT LIKE "%'CONFIRMED'%",
      "SELECT 1",
      IF(
        @status_type LIKE "%'REVERSED'%",
        "SELECT 1",
        "ALTER TABLE trade_fills MODIFY COLUMN status ENUM('CONFIRMED','REVERSED') NOT NULL DEFAULT 'CONFIRMED'"
      )
    )
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- reversed_at
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=@db AND table_name='trade_fills' AND column_name='reversed_at') = 0,
    "ALTER TABLE trade_fills ADD COLUMN reversed_at TIMESTAMP NULL",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- reversed_by
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=@db AND table_name='trade_fills' AND column_name='reversed_by') = 0,
    "ALTER TABLE trade_fills ADD COLUMN reversed_by CHAR(36) NULL",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- reversal_reference_id
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=@db AND table_name='trade_fills' AND column_name='reversal_reference_id') = 0,
    "ALTER TABLE trade_fills ADD COLUMN reversal_reference_id VARCHAR(64) NULL",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- reversal_wallet_tx_id
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=@db AND table_name='trade_fills' AND column_name='reversal_wallet_tx_id') = 0,
    "ALTER TABLE trade_fills ADD COLUMN reversal_wallet_tx_id BIGINT NULL",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- -------------------------
-- 2) Indexes (idempotent)
-- -------------------------

-- Unique index for reversal_reference_id
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema=@db AND table_name='trade_fills'
        AND index_name='uq_trade_fills_reversal_reference_id') = 0,
    "CREATE UNIQUE INDEX uq_trade_fills_reversal_reference_id ON trade_fills (reversal_reference_id)",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index for latest-fill checks
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema=@db AND table_name='trade_fills'
        AND index_name='idx_trade_fills_user_symbol_id') = 0,
    "CREATE INDEX idx_trade_fills_user_symbol_id ON trade_fills (user_id, symbol, id)",
    "SELECT 1"
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
