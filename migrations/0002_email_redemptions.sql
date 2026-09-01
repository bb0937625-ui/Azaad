-- Email-based redemption flow
ALTER TABLE users ADD COLUMN awaiting_email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE redemptions ADD COLUMN email TEXT;
ALTER TABLE redemptions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE redemptions ADD COLUMN handled_at DATETIME;
