CREATE TABLE orchid_shipping_maps (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_encrypted text NOT NULL,
  daily_limit integer NOT NULL DEFAULT 200 CHECK (daily_limit BETWEEN 1 AND 10000),
  usage_day date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
  usage_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orchid_shipping_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchid_shipping_maps FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON orchid_shipping_maps
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON orchid_shipping_maps TO penai_app;
