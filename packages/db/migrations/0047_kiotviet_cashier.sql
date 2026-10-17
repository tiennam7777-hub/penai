-- KiotViet user shown as the creator of PenAI order slips.
ALTER TABLE kiotviet_credentials
  ADD COLUMN cashier_user_id bigint,
  ADD COLUMN cashier_username text;
