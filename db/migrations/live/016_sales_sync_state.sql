-- 016_sales_sync_state.sql
CREATE TABLE IF NOT EXISTS public.sales_sync_state (
  business_id           BIGINT PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  initial_backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
  initial_backfill_at   timestamptz,
  last_daily_sync_at    date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='sales_sync_state_touch') THEN
    CREATE TRIGGER sales_sync_state_touch
    BEFORE UPDATE ON public.sales_sync_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_sales_sync_state_last_daily
  ON public.sales_sync_state (last_daily_sync_at);
