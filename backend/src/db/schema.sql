SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS send_logs;
DROP TABLE IF EXISTS scheduled_emails;
DROP TABLE IF EXISTS prospects;
DROP TABLE IF EXISTS sequence_steps;
DROP TABLE IF EXISTS sequences;
DROP TABLE IF EXISTS mailboxes;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE mailboxes (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,
  email         VARCHAR(255) NOT NULL,
  daily_limit   INT NOT NULL DEFAULT 100,
  hourly_limit  INT NOT NULL DEFAULT 10,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY mailboxes_user_idx (user_id),
  CONSTRAINT fk_mailboxes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sequences (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  name       VARCHAR(255) NOT NULL,
  status     ENUM('draft','active','paused','completed') NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY sequences_user_idx (user_id),
  CONSTRAINT fk_sequences_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sequence_steps (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sequence_id INT UNSIGNED NOT NULL,
  step_order  INT NOT NULL,
  delay_days  INT NOT NULL DEFAULT 0,
  subject     VARCHAR(500) NOT NULL,
  body        TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY seq_step_uniq (sequence_id, step_order),
  CONSTRAINT fk_steps_seq FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE prospects (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sequence_id INT UNSIGNED NOT NULL,
  email       VARCHAR(255) NOT NULL,
  name        VARCHAR(255) NULL,
  status      ENUM('active','unsubscribed','bounced') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  KEY prospects_seq_idx (sequence_id),
  CONSTRAINT fk_prospects_seq FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE scheduled_emails (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sequence_id  INT UNSIGNED NOT NULL,
  step_id      INT UNSIGNED NOT NULL,
  prospect_id  INT UNSIGNED NOT NULL,
  mailbox_id   INT UNSIGNED NOT NULL,
  scheduled_at DATETIME NOT NULL,
  status       ENUM('pending','processing','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  last_error   VARCHAR(500) NULL,
  sent_at      DATETIME NULL,
  claimed_at   DATETIME NULL,
  PRIMARY KEY (id),
  KEY se_status_time_idx (status, scheduled_at),
  KEY se_seq_status_idx (sequence_id, status),
  KEY se_mailbox_sent_idx (mailbox_id, sent_at),
  KEY se_status_claimed_idx (status, claimed_at),
  CONSTRAINT fk_se_seq FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE,
  CONSTRAINT fk_se_step FOREIGN KEY (step_id) REFERENCES sequence_steps(id) ON DELETE CASCADE,
  CONSTRAINT fk_se_prospect FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE,
  CONSTRAINT fk_se_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE send_logs (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scheduled_email_id  INT UNSIGNED NOT NULL,
  mailbox_id          INT UNSIGNED NOT NULL,
  status              VARCHAR(50) NOT NULL,
  message             VARCHAR(500) NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY sl_se_idx (scheduled_email_id),
  CONSTRAINT fk_sl_se FOREIGN KEY (scheduled_email_id) REFERENCES scheduled_emails(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
