CREATE TABLE misa_accounting_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_thread_id text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('draft_saved', 'issued', 'missing_info')),
  target_thread_id text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  message text NOT NULL,
  group_message_id text,
  misa_ref_id text,
  response_message_id text,
  buyer_tax_code text,
  buyer_company_name text,
  buyer_address text,
  buyer_email text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_channel_id, source_thread_id, event_key)
);
CREATE UNIQUE INDEX misa_accounting_group_message_idx
  ON misa_accounting_notifications(source_channel_id, target_thread_id, group_message_id)
  WHERE group_message_id IS NOT NULL;
CREATE INDEX misa_accounting_source_idx
  ON misa_accounting_notifications(source_channel_id, source_thread_id, created_at DESC);
ALTER TABLE misa_accounting_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE misa_accounting_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON misa_accounting_notifications
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON misa_accounting_notifications TO penai_app;
