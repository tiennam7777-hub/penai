-- Quyền xem Inbox riêng với quyền dùng kênh qua MCP.
CREATE TABLE inbox_user_access (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX inbox_user_access_user_idx ON inbox_user_access(workspace_id, user_id);

-- Giữ nguyên quyền hiện có khi nâng cấp: member theo kênh đã gán,
-- moderator/operator theo tất cả kênh cá nhân.
INSERT INTO inbox_user_access (workspace_id, channel_id, user_id)
SELECT m.workspace_id, c.id, m.user_id
FROM workspace_members m
JOIN channels c ON c.workspace_id = m.workspace_id
WHERE c.kind IN ('zalo_personal', 'whatsapp_personal')
  AND m.role IN ('moderator', 'operator')
UNION
SELECT icm.workspace_id, icm.channel_id, icm.user_id
FROM inbox_channel_members icm
JOIN workspace_members m ON m.workspace_id = icm.workspace_id AND m.user_id = icm.user_id
WHERE m.role = 'member';

ALTER TABLE inbox_user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_user_access FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON inbox_user_access
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON inbox_user_access TO penai_app;
