CREATE TABLE IF NOT EXISTS ingest_runs (
  id bigserial PRIMARY KEY,
  business_id int NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  mode text NOT NULL,          -- 'backfill' | 'auto' | 'range'
  range_from date,
  range_to date,
  result jsonb
);
