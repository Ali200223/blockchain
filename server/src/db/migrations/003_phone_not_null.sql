USE crypto_platform;

SELECT COUNT(*) AS null_phones FROM users WHERE phone IS NULL;

ALTER TABLE users
  MODIFY phone VARCHAR(30) NOT NULL;
