ALTER TABLE kiotviet_order_drafts
  ADD COLUMN last_payload_fingerprint text;
ALTER TABLE kiotviet_order_drafts DROP CONSTRAINT kiotviet_order_drafts_status_check;
ALTER TABLE kiotviet_order_drafts ADD CONSTRAINT kiotviet_order_drafts_status_check
  CHECK (status IN ('sending', 'sent', 'updating', 'failed', 'voided'));
