CREATE DATABASE IF NOT EXISTS crypto_platform
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'crypto_migrate'@'localhost' IDENTIFIED BY 'CHANGE_ME_MIGRATE_PASS';
CREATE USER IF NOT EXISTS 'crypto_app'@'localhost' IDENTIFIED BY 'CHANGE_ME_APP_PASS';

GRANT ALL PRIVILEGES ON crypto_platform.* TO 'crypto_migrate'@'localhost';

GRANT SELECT, INSERT, UPDATE, DELETE
ON crypto_platform.* TO 'crypto_app'@'localhost';

FLUSH PRIVILEGES;
