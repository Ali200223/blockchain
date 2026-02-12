-- 005_wallet.sql
-- Wallet + immutable transaction ledger

CREATE TABLE IF NOT EXISTS wallets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  balance DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  currency CHAR(4) NOT NULL DEFAULT 'USDT',
  status ENUM('LOCKED','ACTIVE') NOT NULL DEFAULT 'LOCKED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wallet_user (user_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type ENUM('DEPOSIT','BUY','SELL','WITHDRAW','ADJUST') NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  balance_after DECIMAL(18,2) NOT NULL,
  description VARCHAR(255) NOT NULL,
  reference_id VARCHAR(64) NULL,
  status ENUM('PENDING','CONFIRMED','REVERSED') NOT NULL DEFAULT 'CONFIRMED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_wt_user_time (user_id, created_at),
  INDEX idx_wt_ref (reference_id),
  CONSTRAINT fk_wt_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS withdrawal_accounts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  bank_name VARCHAR(100) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  iban VARCHAR(34) NULL,
  bic VARCHAR(11) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_withdraw_user (user_id),
  CONSTRAINT fk_wa_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE OR REPLACE VIEW v_user_wallet_transactions AS
SELECT
  id,
  user_id,
  type,
  amount,
  balance_after,
  description,
  reference_id,
  created_at
FROM wallet_transactions
WHERE status = 'CONFIRMED';

-- Backfill: create ACTIVE wallets for users already APPROVED (safe to run repeatedly)
INSERT IGNORE INTO wallets (user_id, balance, currency, status)
SELECT user_id, 0.00, 'USDT', 'ACTIVE'
FROM kyc_applications
WHERE status = 'APPROVED';
