-- Review choices for observed Zalo peers. These do not change pairing or AI access.
ALTER TABLE inbox_observed_peers
  ADD COLUMN hidden_in_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN no_approval_needed boolean NOT NULL DEFAULT false;
CREATE INDEX inbox_observed_peers_review_idx
  ON inbox_observed_peers(channel_id, hidden_in_pending, no_approval_needed, last_seen_at DESC);
