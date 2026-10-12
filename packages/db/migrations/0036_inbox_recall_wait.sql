-- Một tin Agent bị nhân viên thu hồi: chờ khách nhắn yêu cầu mới trong đúng hội thoại.
ALTER TABLE inbox_threads
  ADD COLUMN recall_waiting_for_customer boolean NOT NULL DEFAULT false,
  ADD COLUMN agent_recalled_at timestamptz;
