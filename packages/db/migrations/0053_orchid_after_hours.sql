CREATE TABLE orchid_after_hours (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT false,
  activation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE orchid_after_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchid_after_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON orchid_after_hours
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON orchid_after_hours TO penai_app;

CREATE TABLE orchid_after_hours_greetings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  activation_id uuid NOT NULL,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, activation_id, channel_id, thread_id)
);
ALTER TABLE orchid_after_hours_greetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchid_after_hours_greetings FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON orchid_after_hours_greetings
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON orchid_after_hours_greetings TO penai_app;
