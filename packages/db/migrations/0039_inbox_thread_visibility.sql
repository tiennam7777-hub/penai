-- Inbox display preference for each channel conversation. Messages and AI behavior are unchanged.
ALTER TABLE inbox_threads ADD COLUMN hidden_in_inbox boolean NOT NULL DEFAULT false;
CREATE INDEX inbox_threads_visibility_idx ON inbox_threads(channel_id, hidden_in_inbox, last_message_at DESC);
