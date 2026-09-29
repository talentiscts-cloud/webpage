-- ===========================================================================
-- Talentis Consultancy — fee tracking schema (MySQL 5.7+ / MariaDB 10.2+)
--
-- Run this ONCE, in hPanel -> Databases -> phpMyAdmin -> SQL tab, against the
-- database you created. It creates four tables and nothing else.
--
-- Money is stored as INT rupees, never FLOAT. Floating point cannot represent
-- 0.1 exactly, and money that drifts by a paisa in the wrong direction is how
-- billing disputes start. Every amount here is a whole rupee.
--
-- Fee model encoded by this schema:
--   registration  = flat 5000, non-refundable, separate from the placement fee
--   placement fee = a percentage of ctc, due after the first salary
--   the fee may be split into equal instalments; the remainder from an uneven
--   division goes onto instalment 1 so the parts always sum to the fee
--
-- THE PERCENTAGE IS ADMIN-EDITABLE.
-- It is stored as integer BASIS POINTS: 10% = 1000, 12.5% = 1250, 7.25% = 725.
-- Two reasons for basis points rather than a decimal column:
--   1. all fee maths stays in integers, so no float can ever round money wrong
--   2. 12.5% is expressible exactly, which a percentage stored as an int is not
-- The current default lives in `settings`. Each candidate ALSO carries its own
-- fee_bp, copied from the default at the time they were added. That is
-- deliberate: changing the default tomorrow must not silently re-price someone
-- billed last month.
-- ===========================================================================

SET NAMES utf8mb4;
SET time_zone = '+05:30';   -- IST, so dates recorded match the office day

-- ---------------------------------------------------------------------------
-- Admin accounts. Passwords are bcrypt hashes produced by password_hash(),
-- never plaintext and never reversible. Create rows with tools/make-hash.php.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  email           VARCHAR(190)    NOT NULL,
  password_hash   VARCHAR(255)    NOT NULL,
  full_name       VARCHAR(120)    DEFAULT NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  -- Simple brute-force brake: too many misses and the account rests a while.
  failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME        DEFAULT NULL,
  last_login_at   DATETIME        DEFAULT NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Application settings, including the default fee percentage. Key/value so a
-- new setting needs no migration. Values are strings; the API casts them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(64)   NOT NULL,
  setting_value VARCHAR(255)  NOT NULL,
  updated_by    VARCHAR(190)  DEFAULT NULL,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Starting values. 1000 basis points = 10%. Change these from the dashboard,
-- not by editing SQL.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('default_fee_bp',      '1000'),
  ('registration_amount', '5000'),
  ('gst_percent',         '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;   -- never clobber on re-run

-- ---------------------------------------------------------------------------
-- Candidates. Both fee_bp and placement_fee are stored rather than derived on
-- read: together they record what this candidate was actually billed and at
-- what rate, so later changes to the default cannot rewrite history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidates (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  name                VARCHAR(160)  NOT NULL,
  phone               VARCHAR(32)   DEFAULT NULL,
  email               VARCHAR(190)  DEFAULT NULL,
  track               VARCHAR(80)   DEFAULT NULL,
  status              ENUM('training','placed','withdrawn')
                                    NOT NULL DEFAULT 'training',
  admission_date      DATE          DEFAULT NULL,

  -- Registration: the flat 5,000 taken at admission.
  registration_amount INT UNSIGNED  NOT NULL DEFAULT 5000,
  registration_paid   TINYINT(1)    NOT NULL DEFAULT 0,
  registration_date   DATE          DEFAULT NULL,

  -- Placement.
  employer            VARCHAR(160)  DEFAULT NULL,
  joining_date        DATE          DEFAULT NULL,
  first_salary_date   DATE          DEFAULT NULL,
  ctc                 INT UNSIGNED  NOT NULL DEFAULT 0,
  -- Rate applied to THIS candidate, in basis points. 1000 = 10%.
  fee_bp              INT UNSIGNED  NOT NULL DEFAULT 1000,
  placement_fee       INT UNSIGNED  NOT NULL DEFAULT 0,
  emi_count           SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  emi_start           DATE          DEFAULT NULL,

  notes               TEXT          DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_candidates_status (status),
  KEY idx_candidates_name (name),
  KEY idx_candidates_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Instalments against the placement fee. seq is 1-based and unique per
-- candidate, so a schedule can be rebuilt idempotently. ON DELETE CASCADE
-- means removing a candidate takes their schedule with them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instalments (
  id            INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  candidate_id  INT UNSIGNED      NOT NULL,
  seq           SMALLINT UNSIGNED NOT NULL,
  amount        INT UNSIGNED      NOT NULL DEFAULT 0,
  due_date      DATE              DEFAULT NULL,
  paid          TINYINT(1)        NOT NULL DEFAULT 0,
  paid_amount   INT UNSIGNED      NOT NULL DEFAULT 0,
  paid_date     DATE              DEFAULT NULL,
  created_at    TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_instalment_seq (candidate_id, seq),
  KEY idx_instalments_paid (paid),
  CONSTRAINT fk_instalments_candidate
    FOREIGN KEY (candidate_id) REFERENCES candidates (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Append-only trail. These are money records, so every change should leave a
-- mark. Deliberately has no UPDATE path in the application code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id      INT UNSIGNED    DEFAULT NULL,
  admin_email   VARCHAR(190)    DEFAULT NULL,
  action        VARCHAR(48)     NOT NULL,
  candidate_id  INT UNSIGNED    DEFAULT NULL,
  detail        TEXT            DEFAULT NULL,
  ip            VARCHAR(45)     DEFAULT NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_created (created_at),
  KEY idx_audit_candidate (candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Convenience view: current balance per candidate. Read-only reporting, handy
-- straight from phpMyAdmin when you want a figure without opening the app.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_candidate_balances AS
SELECT
  c.id,
  c.name,
  c.status,
  c.employer,
  c.ctc,
  c.fee_bp,
  ROUND(c.fee_bp / 100, 2) AS fee_percent,
  c.placement_fee,
  c.registration_paid,
  CASE WHEN c.registration_paid = 1 THEN c.registration_amount ELSE 0 END
    AS registration_collected,
  COALESCE(SUM(CASE WHEN i.paid = 1 THEN i.paid_amount ELSE 0 END), 0)
    AS placement_collected,
  GREATEST(
    c.placement_fee
      - COALESCE(SUM(CASE WHEN i.paid = 1 THEN i.paid_amount ELSE 0 END), 0),
    0
  ) AS placement_pending,
  COUNT(i.id)                                   AS instalments_total,
  COALESCE(SUM(CASE WHEN i.paid = 1 THEN 1 ELSE 0 END), 0) AS instalments_paid
FROM candidates c
LEFT JOIN instalments i ON i.candidate_id = c.id
GROUP BY c.id;

-- ---------------------------------------------------------------------------
-- Callback / enquiry inbox. Identical to migrations/002_enquiries.sql, kept
-- here too so a fresh install gets everything from one file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enquiries (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  kind            ENUM('candidate','employer') NOT NULL DEFAULT 'candidate',
  name            VARCHAR(160)  NOT NULL,
  phone           VARCHAR(32)   DEFAULT NULL,
  email           VARCHAR(190)  DEFAULT NULL,
  company         VARCHAR(160)  DEFAULT NULL,
  track           VARCHAR(80)   DEFAULT NULL,
  current_status  VARCHAR(80)   DEFAULT NULL,
  batch_format    VARCHAR(40)   DEFAULT NULL,
  hiring_model    VARCHAR(80)   DEFAULT NULL,
  positions       VARCHAR(20)   DEFAULT NULL,
  message         TEXT          DEFAULT NULL,
  consent         TINYINT(1)    NOT NULL DEFAULT 0,
  source_page     VARCHAR(120)  DEFAULT NULL,
  status          ENUM('new','contacted','admitted','not_interested','spam')
                                NOT NULL DEFAULT 'new',
  admin_notes     TEXT          DEFAULT NULL,
  contacted_at    DATETIME      DEFAULT NULL,
  candidate_id    INT UNSIGNED  DEFAULT NULL,
  ip_hash         CHAR(64)      DEFAULT NULL,
  user_agent      VARCHAR(255)  DEFAULT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_enquiries_status    (status),
  KEY idx_enquiries_created   (created_at),
  KEY idx_enquiries_ip        (ip_hash, created_at),
  KEY idx_enquiries_candidate (candidate_id),
  CONSTRAINT fk_enquiries_candidate
    FOREIGN KEY (candidate_id) REFERENCES candidates (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
