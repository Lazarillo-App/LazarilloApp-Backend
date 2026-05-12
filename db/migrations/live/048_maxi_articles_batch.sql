-- migrations/live/048_maxi_articles_batch.sql
-- Tracking de lotes de subida manual de artículos

ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS upload_batch_id TEXT;
ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'maxi';

CREATE INDEX IF NOT EXISTS idx_maxi_articles_batch
  ON maxi_articles(business_id, upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;

-- Marcar los artículos existentes como de origen maxi
UPDATE maxi_articles SET origen = 'maxi' WHERE origen IS NULL;