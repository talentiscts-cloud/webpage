-- ===========================================================================
-- Talentis — migration 002: callback / enquiry inbox
--
-- RUN THIS ONCE in phpMyAdmin -> your database -> SQL tab.
-- It only ADDS a table. Existing candidates, payments and settings are not
-- touched, and running it twice is harmless.
--
-- Every callback request from the public website (Contact page and Employers
-- page) lands here. From the dashboard you can review it, mark it contacted,
-- and "Admit" it, which creates a candidate record and links the two.
-- ===========================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS enquiries (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,

  -- 'candidate' from the Contact page, 'employer' from the Employers page.
  kind            ENUM('candidate','employer') NOT NULL DEFAULT 'candidate',

  -- Who
  name            VARCHAR(160)  NOT NULL,
  phone           VARCHAR(32)   DEFAULT NULL,
  email           VARCHAR(190)  DEFAULT NULL,
  company         VARCHAR(160)  DEFAULT NULL,   -- employers only

  -- What they told us (candidate form)
  track           VARCHAR(80)   DEFAULT NULL,
  current_status  VARCHAR(80)   DEFAULT NULL,   -- "Graduate", "Working, want to switch" ...
  batch_format    VARCHAR(40)   DEFAULT NULL,

  -- What they told us (employer form)
  hiring_model    VARCHAR(80)   DEFAULT NULL,
  positions       VARCHAR(20)   DEFAULT NULL,

  message         TEXT          DEFAULT NULL,
  consent         TINYINT(1)    NOT NULL DEFAULT 0,
  source_page     VARCHAR(120)  DEFAULT NULL,

  -- Workflow
  status          ENUM('new','contacted','admitted','not_interested','spam')
                                NOT NULL DEFAULT 'new',
  admin_notes     TEXT          DEFAULT NULL,
  contacted_at    DATETIME      DEFAULT NULL,
  -- Set when admitted. SET NULL rather than CASCADE: deleting a candidate
  -- later should not erase the record that they once enquired.
  candidate_id    INT UNSIGNED  DEFAULT NULL,

  -- Abuse control. The IP is stored only as a keyed hash, enough to rate-limit
  -- repeat submissions without keeping visitors' raw addresses.
  ip_hash         CHAR(64)      DEFAULT NULL,
  user_agent      VARCHAR(255)  DEFAULT NULL,

  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_enquiries_status   (status),
  KEY idx_enquiries_created  (created_at),
  KEY idx_enquiries_ip       (ip_hash, created_at),
  KEY idx_enquiries_candidate (candidate_id),
  CONSTRAINT fk_enquiries_candidate
    FOREIGN KEY (candidate_id) REFERENCES candidates (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
