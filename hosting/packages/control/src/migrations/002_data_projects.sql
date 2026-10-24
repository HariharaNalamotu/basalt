-- Each environment's Basalt Cloud data project (the Data block), when Cloud is configured.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS data_project_id text;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS data_admin_key_enc bytea;
