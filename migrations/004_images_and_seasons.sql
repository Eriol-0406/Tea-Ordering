-- Uploaded images and seasonal availability.
--
-- Images are stored in Postgres rather than an object store: the menu is a few
-- dozen pictures, browser-side resizing keeps each well under 200KB, and it
-- avoids introducing another service and another secret to manage. Existing
-- drinks keep pointing at files in public/images via image_url; uploads use
-- image_id and are served from /api/images/:id.

CREATE TABLE IF NOT EXISTS menu_images (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mime_type  TEXT   NOT NULL,
  bytes      BYTEA  NOT NULL,
  byte_size  INTEGER NOT NULL,
  width      SMALLINT,
  height     SMALLINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS image_id BIGINT REFERENCES menu_images(id) ON DELETE SET NULL,
  -- Seasonal drinks: outside this window the drink stops appearing to
  -- customers on its own, without anyone remembering to switch it off.
  ADD COLUMN IF NOT EXISTS available_from  DATE,
  ADD COLUMN IF NOT EXISTS available_until DATE;

CREATE INDEX IF NOT EXISTS idx_items_season ON menu_items (available_until);

ALTER TABLE menu_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON menu_images FROM anon, authenticated;
