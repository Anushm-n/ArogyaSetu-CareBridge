CREATE DATABASE IF NOT EXISTS arogyasetu_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE arogyasetu_db;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) NOT NULL,
  role ENUM('patient', 'caretaker', 'doctor', 'nurse', 'hospital', 'admin', 'volunteer') NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(64) NULL,
  language VARCHAR(16) NOT NULL DEFAULT 'en',
  meta JSON NULL,
  extra_json JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS medicines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  dose VARCHAR(255) NULL,
  notes TEXT NULL,
  time VARCHAR(64) NULL,
  status VARCHAR(32) NOT NULL,
  status_date DATE NULL,
  display_order BIGINT NOT NULL,
  extra_json JSON NULL,
  PRIMARY KEY (id),
  KEY idx_medicines_display_order (display_order)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type VARCHAR(64) NOT NULL,
  title TEXT NULL,
  detail TEXT NULL,
  time VARCHAR(64) NULL,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  display_order BIGINT NOT NULL,
  extra_json JSON NULL,
  PRIMARY KEY (id),
  KEY idx_alerts_display_order (display_order),
  KEY idx_alerts_acknowledged (acknowledged)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vitals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  time VARCHAR(128) NULL,
  bp VARCHAR(128) NULL,
  sugar VARCHAR(128) NULL,
  recorded_by VARCHAR(255) NULL,
  display_order BIGINT NOT NULL,
  extra_json JSON NULL,
  PRIMARY KEY (id),
  KEY idx_vitals_display_order (display_order)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sos (
  id TINYINT UNSIGNED NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp VARCHAR(64) NULL,
  triggered_by VARCHAR(255) NULL,
  extra_json JSON NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_user_id (user_id),
  KEY idx_sessions_expires_at (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

