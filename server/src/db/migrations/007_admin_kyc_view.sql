CREATE OR REPLACE VIEW v_admin_kyc_applications AS
SELECT
  u.id AS user_id,
  u.email,
  u.phone,
  ka.level,
  ka.status,
  ka.full_name,
  ka.dob,
  ka.country,
  ka.doc_type,
  ka.doc_number_last4,
  ka.submitted_at,
  ka.reviewed_by,
  ka.review_notes,
  ka.updated_at
FROM kyc_applications ka
JOIN users u ON u.id = ka.user_id;
