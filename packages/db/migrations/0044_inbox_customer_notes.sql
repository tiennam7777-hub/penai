-- Ghi chú nội bộ của từng khách trong Inbox, tách theo kênh và hội thoại.
-- Không thuộc nội dung tin nhắn và không được đưa vào ngữ cảnh Agent.
ALTER TABLE inbox_threads ADD COLUMN customer_note text NOT NULL DEFAULT '';
ALTER TABLE inbox_threads ADD COLUMN customer_note_updated_at timestamptz;
