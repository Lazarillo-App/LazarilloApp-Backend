CREATE TABLE IF NOT EXISTS raw_maxi_payloads (
  id bigserial PRIMARY KEY,
  business_id int NOT NULL,
  day date NOT NULL,
  source jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, day)
);
