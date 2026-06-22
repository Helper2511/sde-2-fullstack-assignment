-- Seed data for the Email Sequencer take-home.
--
-- Passwords: every account's password is `password123`.
-- The hash below is a real bcrypt hash of `password123` (cost 10).
--
-- Accounts (see README):
--   alice@test.com -> 3 mailboxes, 2 sequences (sequence 1 is pre-scheduled)
--   bob@test.com   -> 1 mailbox, no sequences

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, password_hash) VALUES
  (1, 'alice@test.com', '$2b$10$QmZHPKlsMq8YercgZRhXPODWrJAxF5xBRk38j0IwzGi8CnbjVSZzm'),
  (2, 'bob@test.com',   '$2b$10$QmZHPKlsMq8YercgZRhXPODWrJAxF5xBRk38j0IwzGi8CnbjVSZzm');

-- ---------------------------------------------------------------------------
-- Mailboxes
-- ---------------------------------------------------------------------------
INSERT INTO mailboxes (id, user_id, email, daily_limit, hourly_limit) VALUES
  (1, 1, 'alice.sales@test.com',   100, 10),
  (2, 1, 'alice.support@test.com', 100, 10),
  (3, 1, 'alice.promo@test.com',    50,  5),
  (4, 2, 'bob.sales@test.com',     100, 10);

-- ---------------------------------------------------------------------------
-- Sequences (alice owns both)
-- ---------------------------------------------------------------------------
INSERT INTO sequences (id, user_id, name, status) VALUES
  (1, 1, 'Welcome Series', 'active'),
  (2, 1, 'Follow-up Drip', 'draft');

-- ---------------------------------------------------------------------------
-- Sequence steps
-- ---------------------------------------------------------------------------
INSERT INTO sequence_steps (id, sequence_id, step_order, delay_days, subject, body) VALUES
  (1, 1, 1, 0, 'Welcome to Acme',        'Hi {{name}}, thanks for signing up!'),
  (2, 1, 2, 2, 'Getting started',        'Hi {{name}}, here are a few tips to get going.'),
  (3, 1, 3, 4, 'Anything we can help with?', 'Hi {{name}}, just checking in.'),
  (4, 2, 1, 0, 'Quick follow-up',        'Hi {{name}}, following up on our chat.'),
  (5, 2, 2, 3, 'One more thing',         'Hi {{name}}, one last note for you.');

-- ---------------------------------------------------------------------------
-- Prospects (attached to sequence 1)
-- ---------------------------------------------------------------------------
INSERT INTO prospects (id, sequence_id, email, name, status) VALUES
  (1, 1, 'casey@example.com', 'Casey',  'active'),
  (2, 1, 'dana@example.com',  'Dana',   'active'),
  (3, 1, 'erin@example.com',  'Erin',   'active');

-- ---------------------------------------------------------------------------
-- Pre-scheduled sends for sequence 1, step 1 (one per prospect), due NOW so the
-- worker has immediate work as soon as it starts. setup-db.ts enqueues a BullMQ
-- job for each of these pending rows after the seed is applied.
-- ---------------------------------------------------------------------------
INSERT INTO scheduled_emails
  (sequence_id, step_id, prospect_id, mailbox_id, scheduled_at, status, attempts) VALUES
  (1, 1, 1, 1, NOW(), 'pending', 0),
  (1, 1, 2, 1, NOW(), 'pending', 0),
  (1, 1, 3, 1, NOW(), 'pending', 0);
