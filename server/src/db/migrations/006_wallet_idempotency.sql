ALTER TABLE wallet_transactions
ADD UNIQUE KEY uq_wt_user_ref (user_id, reference_id);
