-- 009_trading.sql
-- Paper trading core: holdings (state) + fills (events)
-- Designed to integrate with wallet_transactions + ledger receipts

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  symbol VARCHAR(20) NOT NULL,

  -- Crypto quantities need higher precision than cash.
  quantity DECIMAL(36,18) NOT NULL DEFAULT 0,

  -- Average entry price in quote currency (USDT)
  avg_cost DECIMAL(18,8) NOT NULL DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_hold_user_symbol (user_id, symbol),
  KEY idx_hold_user (user_id),
  KEY idx_hold_symbol (symbol),

  CONSTRAINT fk_hold_user FOREIGN KEY (user_id) REFERENCES users(id),

  CONSTRAINT chk_hold_qty_nonneg CHECK (quantity >= 0),
  CONSTRAINT chk_hold_avg_nonneg CHECK (avg_cost >= 0)
);

CREATE TABLE IF NOT EXISTS trade_fills (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,

  side ENUM('BUY','SELL') NOT NULL,
  symbol VARCHAR(20) NOT NULL,

  qty   DECIMAL(36,18) NOT NULL,
  price DECIMAL(18,8) NOT NULL,

  -- Quote-currency (USDT) values that actually move the wallet (2dp)
  gross_quote DECIMAL(18,2) NOT NULL,
  fee_quote   DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_quote   DECIMAL(18,2) NOT NULL,

  -- Link to wallet movement row (recommended)
  wallet_tx_id BIGINT NULL,

  -- Idempotency at trade level (UUID from client)
  reference_id CHAR(36) NOT NULL,

  -- Optional traceability (requestContext.requestId)
  request_id CHAR(36) NULL,

  status ENUM('FILLED','REVERSED') NOT NULL DEFAULT 'FILLED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Optional: ledger pointers (so you can do /receipt/trade/:id later)
  ledger_block_height INT NULL,
  ledger_item_idx INT NULL,
  ledger_block_hash VARCHAR(64) NULL,
  ledger_commit_key VARCHAR(64) NULL,
  ledger_committed_at TIMESTAMP NULL,

  UNIQUE KEY uq_trade_user_ref (user_id, reference_id),

  KEY idx_trade_user_time (user_id, created_at),
  KEY idx_trade_symbol_time (symbol, created_at),
  KEY idx_trade_wallet_tx (wallet_tx_id),
  KEY idx_trade_ledger_ptr (ledger_block_height, ledger_item_idx),

  CONSTRAINT fk_trade_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_trade_wallet_tx FOREIGN KEY (wallet_tx_id) REFERENCES wallet_transactions(id),

  CONSTRAINT chk_trade_qty_pos CHECK (qty > 0),
  CONSTRAINT chk_trade_price_pos CHECK (price > 0),
  CONSTRAINT chk_trade_gross_nonneg CHECK (gross_quote >= 0),
  CONSTRAINT chk_trade_fee_nonneg CHECK (fee_quote >= 0)
);

CREATE OR REPLACE VIEW v_portfolio_holdings AS
SELECT user_id, symbol, quantity, avg_cost, updated_at
FROM portfolio_holdings;

CREATE OR REPLACE VIEW v_trade_fills AS
SELECT
  id, user_id, side, symbol, qty, price,
  gross_quote, fee_quote, net_quote,
  wallet_tx_id, reference_id, request_id,
  status, created_at,
  ledger_block_height, ledger_item_idx, ledger_block_hash, ledger_commit_key, ledger_committed_at
FROM trade_fills;
