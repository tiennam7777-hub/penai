-- Shared, text-only Inbox snippets. Insertion into a draft never sends a message.
CREATE TABLE inbox_quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  shortcut text NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, shortcut)
);

ALTER TABLE inbox_quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_quick_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON inbox_quick_replies
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_quick_replies TO penai_app;
