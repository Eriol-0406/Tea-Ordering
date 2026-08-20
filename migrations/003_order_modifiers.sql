-- Line items become modifier-agnostic.
--
-- The old columns (ice, sugar, tea_base, addons_text) hardcoded one shop's
-- modifier vocabulary into the schema. Adding a modifier meant a migration.
-- Selections now live in their own table, which is also what makes "add-on
-- sales" reportable, and each line records the company and category so revenue
-- can be split between OTea and GreyOne per item rather than per bill.

ALTER TABLE order_items
  DROP COLUMN IF EXISTS ice,
  DROP COLUMN IF EXISTS sugar,
  DROP COLUMN IF EXISTS tea_base,
  DROP COLUMN IF EXISTS addons_text;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS variant_id     INTEGER,
  ADD COLUMN IF NOT EXISTS base_price     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS modifiers_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category       TEXT,
  ADD COLUMN IF NOT EXISTS company        TEXT;

-- One row per chosen option. Names and prices are copied, not referenced, so a
-- later menu edit never rewrites history.
CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  group_id      SMALLINT,
  option_id     SMALLINT,
  group_name    TEXT NOT NULL,
  option_name   TEXT NOT NULL,
  price_delta   NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_oim_item   ON order_item_modifiers (order_item_id);
CREATE INDEX IF NOT EXISTS idx_oim_option ON order_item_modifiers (option_id);
CREATE INDEX IF NOT EXISTS idx_items_company ON order_items (company);

ALTER TABLE order_item_modifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON order_item_modifiers FROM anon, authenticated;
