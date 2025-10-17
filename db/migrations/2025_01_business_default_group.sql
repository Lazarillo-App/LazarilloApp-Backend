ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS default_group_id INT NULL;
