-- Users table: every Telegram user who starts the bot
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  referred_by INTEGER,              -- telegram_id of referrer (nullable)
  joined_channels INTEGER NOT NULL DEFAULT 0,  -- 0 = not verified, 1 = verified both channels
  welcome_bonus_given INTEGER NOT NULL DEFAULT 0, -- 1 point on first verified join
  referral_counted INTEGER NOT NULL DEFAULT 0,    -- did referrer already get a point for this user
  total_referrals INTEGER NOT NULL DEFAULT 0,
  total_redeemed INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Settings key-value table (canva link, channels list, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Redemption log
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  points_spent INTEGER NOT NULL DEFAULT 1,
  invite_link TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_redemptions_tid ON redemptions(telegram_id);

-- Default settings (admin updates via bot commands)
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('canva_link', ''),
  ('channels', '[]'),
  ('admin_ids', '[]');
