-- Multi-product rewards support
ALTER TABLE redemptions ADD COLUMN product TEXT NOT NULL DEFAULT 'canva';
ALTER TABLE users ADD COLUMN awaiting_product TEXT;
