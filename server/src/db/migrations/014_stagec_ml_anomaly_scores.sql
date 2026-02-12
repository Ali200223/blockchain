-- 015_stagec_ml_anomaly_scores.sql
-- Purpose: Stage C - Persist ML anomaly scoring results (features + raw response) per session

CREATE TABLE IF NOT EXISTS session_ml_anomaly_scores (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,

  session_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,

  intent VARCHAR(64) NULL,


  anomaly_score DECIMAL(10,6) NOT NULL,
  model_version VARCHAR(32) NULL,

  
  features JSON NOT NULL,

  raw_response JSON NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_smas_session_time (session_id, created_at),
  INDEX idx_smas_user_time (user_id, created_at),
  INDEX idx_smas_score_time (anomaly_score, created_at),

  CONSTRAINT fk_smas_session FOREIGN KEY (session_id) REFERENCES auth_sessions(id),
  CONSTRAINT fk_smas_user FOREIGN KEY (user_id) REFERENCES users(id)
);
