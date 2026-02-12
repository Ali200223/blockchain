-- 004_kyc_required_when_submitted.sql
SELECT VERSION() AS mysql_version;

SELECT
  id, user_id, status,
  full_name, dob, country, doc_type, doc_number_hash, submitted_at
FROM kyc_applications
WHERE status <> 'NOT_SUBMITTED'
  AND (
    full_name IS NULL OR full_name = '' OR
    dob IS NULL OR
    country IS NULL OR country = '' OR
    doc_type IS NULL OR
    doc_number_hash IS NULL OR doc_number_hash = '' OR
    submitted_at IS NULL
  );

ALTER TABLE kyc_applications
ADD CONSTRAINT chk_kyc_required_when_submitted
CHECK (
  status = 'NOT_SUBMITTED'
  OR (
    full_name IS NOT NULL AND full_name <> '' AND
    dob IS NOT NULL AND
    country IS NOT NULL AND country <> '' AND
    doc_type IS NOT NULL AND
    doc_number_hash IS NOT NULL AND doc_number_hash <> '' AND
    submitted_at IS NOT NULL
  )
);
