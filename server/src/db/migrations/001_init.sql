-- 001_init.sql
-- Purpose: Core auth + security logging + KYC binding tables for Week 1

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(30)  NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('user','admin') DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  email_verified BOOLEAN DEFAULT false,
  phone_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  INDEX idx_user (user_id),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS security_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NULL,
  event_type VARCHAR(50) NOT NULL,
  ip VARCHAR(45) NULL,
  user_agent TEXT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at),
  INDEX idx_event_time (event_type, created_at),
  CONSTRAINT fk_sl_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS kyc_applications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL UNIQUE,
  level ENUM('L1','L2') DEFAULT 'L1',
  status ENUM('NOT_SUBMITTED','PENDING','APPROVED','REJECTED') DEFAULT 'NOT_SUBMITTED',
  full_name VARCHAR(255) NULL,
  dob DATE NULL,
  country VARCHAR(2) NULL,
  doc_type ENUM('PASSPORT') NULL,
  doc_number_hash VARCHAR(255) NULL,
  submitted_at TIMESTAMP NULL,
  reviewed_by CHAR(36) NULL,
  review_notes TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ka_user FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE KEY uq_doc_hash (doc_number_hash)
);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kyc_application_id BIGINT NOT NULL,
  doc_side ENUM('FRONT','BACK','SELFIE') NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size INT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ka (kyc_application_id),
  CONSTRAINT fk_kd_ka FOREIGN KEY (kyc_application_id) REFERENCES kyc_applications(id)
);
