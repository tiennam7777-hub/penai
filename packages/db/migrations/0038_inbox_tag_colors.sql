-- Existing Inbox labels get a visible blue color; users may change it later.
ALTER TABLE inbox_tags ADD COLUMN color text NOT NULL DEFAULT '#2563EB'
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
