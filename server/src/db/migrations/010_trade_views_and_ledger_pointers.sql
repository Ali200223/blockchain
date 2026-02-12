-- 011_trade_views_and_ledger_pointers.sql

CREATE OR REPLACE VIEW v_portfolio_holdings AS
SELECT id, user_id, symbol, quantity, avg_cost, created_at, updated_at
FROM portfolio_holdings;

CREATE OR REPLACE VIEW v_trade_fills AS
SELECT
  id, user_id, side, symbol, qty, price,
  gross_quote, fee_quote, net_quote,
  wallet_tx_id, reference_id, request_id,
  status, created_at,
  ledger_block_height, ledger_item_idx,
  ledger_block_hash, ledger_commit_key, ledger_committed_at
FROM trade_fills;
