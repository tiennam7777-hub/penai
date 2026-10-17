-- A claimed source order is never posted twice, including after a timeout or restart.
CREATE TABLE kiotviet_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_channel_id uuid NOT NULL REFERENCES channels(id),
  source_thread_id text NOT NULL,
  order_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  kiot_order_id bigint,
  kiot_order_code text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, source_thread_id, order_fingerprint)
);
CREATE INDEX kiotviet_order_drafts_source_idx
  ON kiotviet_order_drafts(source_channel_id, source_thread_id, created_at DESC);
ALTER TABLE kiotviet_order_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiotviet_order_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON kiotviet_order_drafts
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON kiotviet_order_drafts TO penai_app;
