ALTER TABLE kyc_applications
  ADD COLUMN doc_number_last4 VARCHAR(4) NULL,
  ADD COLUMN doc_number_enc BLOB NULL,
  ADD COLUMN doc_number_iv VARBINARY(12) NULL,
  ADD COLUMN doc_number_tag VARBINARY(16) NULL;
