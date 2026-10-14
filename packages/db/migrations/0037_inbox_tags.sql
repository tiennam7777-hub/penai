-- Inbox labels belong to a channel conversation, independently of Contacts
-- approval, principals, and AI instructions.
CREATE TABLE inbox_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbox_tags_name_uq ON inbox_tags(workspace_id, lower(name));

CREATE TABLE inbox_thread_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL,
  thread_id text NOT NULL,
  tag_id uuid NOT NULL REFERENCES inbox_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, thread_id, tag_id),
  FOREIGN KEY (channel_id, thread_id) REFERENCES inbox_threads(channel_id, thread_id) ON DELETE CASCADE
);
CREATE INDEX inbox_thread_tags_tag_idx ON inbox_thread_tags(tag_id, channel_id, thread_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inbox_tags', 'inbox_thread_tags'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO penai_app', t);
  END LOOP;
END $$;
