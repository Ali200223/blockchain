-- 014_sessions_and_risk_scoring.sql
-- Purpose: Session lifecycle + auditable risk scoring (Person A deliverable)

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,

  device_id VARCHAR(128) NULL,
  ip VARCHAR(45) NULL,
  user_agent TEXT NULL,
  context_hash CHAR(64) NULL,

  is_active BOOLEAN DEFAULT true,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,

  ended_at TIMESTAMP NULL,
  ended_reason VARCHAR(64) NULL,

  last_risk_score INT NULL,
  last_action ENUM('ALLOW','STEP_UP_REQUIRED','BLOCK_SENSITIVE') NULL,
  last_scored_at TIMESTAMP NULL,

  -- Enforce at most ONE active session per (user, device). Multiple inactive sessions allowed.
  active_device_key VARCHAR(128) GENERATED ALWAYS AS (IF(is_active, device_id, NULL)) STORED,
  UNIQUE KEY uq_user_active_device (user_id, active_device_key),

  INDEX idx_user_active (user_id, is_active, last_seen),
  INDEX idx_session_exp (expires_at),

  CONSTRAINT fk_as_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS session_risk_scores (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,

  risk_score INT NOT NULL,
  action ENUM('ALLOW','STEP_UP_REQUIRED','BLOCK_SENSITIVE') NOT NULL,

  rule_version VARCHAR(32) NOT NULL,
  ml_version VARCHAR(32) NULL,

  factors JSON NULL,
  ctx JSON NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_session_time (session_id, created_at),
  INDEX idx_user_time (user_id, created_at),

  CONSTRAINT fk_srs_session FOREIGN KEY (session_id) REFERENCES auth_sessions(id),
  CONSTRAINT fk_srs_user FOREIGN KEY (user_id) REFERENCES users(id)
);
