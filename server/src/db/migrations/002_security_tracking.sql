CREATE TABLE IF NOT EXISTS user_devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT NULL,
  last_ip VARCHAR(45) NULL,
  UNIQUE KEY uq_user_device (user_id, device_id),
  INDEX idx_user_lastseen (user_id, last_seen),
  CONSTRAINT fk_ud_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_ip_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  ip VARCHAR(45) NOT NULL,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_ip (user_id, ip),
  INDEX idx_user_ip_lastseen (user_id, last_seen),
  CONSTRAINT fk_uih_user FOREIGN KEY (user_id) REFERENCES users(id)
);
