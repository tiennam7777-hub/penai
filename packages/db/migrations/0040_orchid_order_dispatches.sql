-- One notification per confirmed orchid order and source conversation.
CREATE TABLE orchid_order_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_channel_id uuid NOT NULL REFERENCES channels(id),
  source_thread_id text NOT NULL,
  order_fingerprint text NOT NULL,
  target_thread_id text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  message text NOT NULL,
  zalo_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, source_thread_id, order_fingerprint)
);
CREATE INDEX orchid_order_dispatches_source_idx
  ON orchid_order_dispatches(source_channel_id, source_thread_id, created_at DESC);
ALTER TABLE orchid_order_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchid_order_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON orchid_order_dispatches
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON orchid_order_dispatches TO penai_app;
