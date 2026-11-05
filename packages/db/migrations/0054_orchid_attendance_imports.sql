CREATE TABLE orchid_attendance_imports (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  branch_id text NOT NULL CHECK (branch_id IN ('42', '188', '224')),
  branch_name text NOT NULL,
  source_filename text NOT NULL,
  source_sha256 text NOT NULL,
  source_file bytea NOT NULL,
  rows jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month, branch_id)
);
ALTER TABLE orchid_attendance_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchid_attendance_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON orchid_attendance_imports
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT ON orchid_attendance_imports TO penai_app;
