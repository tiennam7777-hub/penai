ALTER TABLE misa_accounting_notifications
  DROP CONSTRAINT misa_accounting_notifications_kind_check;
ALTER TABLE misa_accounting_notifications
  ADD CONSTRAINT misa_accounting_notifications_kind_check
  CHECK (kind IN ('draft_saved', 'issued', 'missing_info', 'increase_request'));
