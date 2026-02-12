-- 008_wallet_tx_schema.sql
-- Week 4: Wallet transaction schema (A/B/C)
-- A) Extend wallet_transactions with currency, request_id, actor metadata, ledger pointers
-- B) Add wallet_transaction_lines (double-entry)
-- C) Add ledger pointers to security_logs for uniform provenance

-- 1) Widen wallet currency (CHAR(3) breaks USDT/BTC etc.)
ALTER TABLE wallets
  MODIFY currency CHAR(10) NOT NULL DEFAULT 'USDT';

-- 2) Extend wallet_transactions
ALTER TABLE wallet_transactions
  ADD COLUMN currency CHAR(10) NOT NULL DEFAULT 'USDT' AFTER balance_after,
  ADD COLUMN request_id VARCHAR(64) NULL AFTER reference_id,
  ADD COLUMN actor_user_id CHAR(36) NULL AFTER request_id,
  ADD COLUMN actor_role VARCHAR(20) NULL AFTER actor_user_id,
  ADD COLUMN actor_ip VARCHAR(45) NULL AFTER actor_role,
  ADD COLUMN actor_user_agent TEXT NULL AFTER actor_ip,
  ADD COLUMN actor_device_id VARCHAR(128) NULL AFTER actor_user_agent,
  ADD COLUMN ledger_block_height INT NULL AFTER actor_device_id,
  ADD COLUMN ledger_block_hash VARCHAR(64) NULL AFTER ledger_block_height,
  ADD COLUMN ledger_commit_key VARCHAR(64) NULL AFTER ledger_block_hash,
  ADD COLUMN ledger_item_idx INT NULL AFTER ledger_commit_key,
  ADD COLUMN ledger_committed_at TIMESTAMP NULL AFTER ledger_item_idx;

CREATE UNIQUE INDEX uq_wallet_tx_request_id ON wallet_transactions (request_id);
CREATE INDEX idx_wallet_tx_user_created ON wallet_transactions (user_id, created_at);
CREATE INDEX idx_wallet_tx_ledger ON wallet_transactions (ledger_block_height, ledger_item_idx);

-- 3) Double-entry lines table (B)
CREATE TABLE IF NOT EXISTS wallet_transaction_lines (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tx_id BIGINT NOT NULL,
  account VARCHAR(32) NOT NULL,
  user_id CHAR(36) NULL,
  currency CHAR(10) NOT NULL,
  delta DECIMAL(18,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_wtl_tx (tx_id),
  INDEX idx_wtl_user_created (user_id, created_at),

  CONSTRAINT fk_wtl_tx FOREIGN KEY (tx_id) REFERENCES wallet_transactions(id) ON DELETE CASCADE
);

-- 4) Add ledger pointers to security_logs (C)
ALTER TABLE security_logs
  ADD COLUMN ledger_block_height INT NULL,
  ADD COLUMN ledger_block_hash VARCHAR(64) NULL,
  ADD COLUMN ledger_commit_key VARCHAR(64) NULL,
  ADD COLUMN ledger_item_idx INT NULL,
  ADD COLUMN ledger_committed_at TIMESTAMP NULL;

CREATE INDEX idx_security_logs_ledger ON security_logs (ledger_block_height, ledger_item_idx);
