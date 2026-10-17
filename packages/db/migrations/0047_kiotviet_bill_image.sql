ALTER TABLE kiotviet_order_drafts
  ADD COLUMN bill_image_status text NOT NULL DEFAULT 'pending'
    CHECK (bill_image_status IN ('pending', 'sent', 'failed')),
  ADD COLUMN bill_image_group_id text,
  ADD COLUMN bill_image_msg_id text,
  ADD COLUMN bill_image_error text;
