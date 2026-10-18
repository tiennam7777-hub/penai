CREATE TABLE misa_credentials (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  tax_code text NOT NULL,
  username text NOT NULL,
  password_encrypted text NOT NULL,
  invoice_series text NOT NULL,
  vat_rate numeric(5,2) NOT NULL,
  price_includes_vat boolean NOT NULL,
  draft_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE misa_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE misa_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON misa_credentials
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON misa_credentials TO penai_app;

CREATE TABLE misa_invoice_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_channel_id uuid NOT NULL,
  source_thread_id text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'saved', 'failed', 'uncertain')),
  misa_ref_id text,
  buyer_name text,
  total_amount numeric(18,2),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_channel_id, source_thread_id, request_fingerprint)
);
CREATE INDEX misa_invoice_drafts_source_idx ON misa_invoice_drafts (source_channel_id, source_thread_id, created_at DESC);
ALTER TABLE misa_invoice_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE misa_invoice_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON misa_invoice_drafts
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON misa_invoice_drafts TO penai_app;
