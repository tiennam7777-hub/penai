-- KiotViet credentials for one retailer per workspace. Values are encrypted by PenAI.
CREATE TABLE kiotviet_credentials (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  retailer text NOT NULL,
  branch_name text NOT NULL,
  branch_id bigint,
  client_id_encrypted text NOT NULL,
  client_secret_encrypted text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kiotviet_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiotviet_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON kiotviet_credentials
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON kiotviet_credentials TO penai_app;
