-- 015_withdrawal_accounts_ifsc.sql
-- Add IFSC code to withdrawal_accounts (for India-style bank routing)
ALTER TABLE withdrawal_accounts
  ADD COLUMN ifsc_code VARCHAR(20) NULL AFTER bic;
