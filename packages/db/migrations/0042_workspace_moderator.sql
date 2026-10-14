-- Role kiểm duyệt có quyền theo tính năng, không thuộc thang operator/viewer.
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('ws_admin', 'operator', 'viewer', 'moderator', 'member'));
