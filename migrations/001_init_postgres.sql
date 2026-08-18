-- OTea x GreyOne - initial Postgres schema
-- Run once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is guarded.

-- ---------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  customer_name  TEXT        NOT NULL,
  phone          TEXT        NOT NULL,
  notes          TEXT        NOT NULL DEFAULT '',
  total          NUMERIC(10,2) NOT NULL,
  payment_method TEXT        NOT NULL,
  payment_status TEXT        NOT NULL,
  status         TEXT        NOT NULL,
  latitude       DOUBLE PRECISION,
  longitude      DOUBLE PRECISION,
  distance       DOUBLE PRECISION,
  zone_name      TEXT,
  spam_risk      TEXT,
  risk_reason    TEXT,
  ip_address     TEXT,
  session_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per drink, so per-item sales can be reported without unpacking JSON.
CREATE TABLE IF NOT EXISTS order_items (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  variant_name TEXT,
  price        NUMERIC(10,2) NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  ice          TEXT,
  sugar        TEXT,
  tea_base     TEXT,
  addons_text  TEXT
);

-- Only sold-out drinks are stored; anything absent is available.
CREATE TABLE IF NOT EXISTS menu_availability (
  menu_item_id INTEGER PRIMARY KEY,
  available    BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Indexes matching how the app actually queries
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders (session_id);
CREATE INDEX IF NOT EXISTS idx_orders_ip_time ON orders (ip_address, created_at);
CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items (order_id);

-- ---------------------------------------------------------------
-- Row Level Security
--
-- Supabase publishes every table in the public schema over PostgREST using the
-- publishable/anon key. These tables hold customer names, phone numbers and GPS
-- coordinates, so RLS is enabled with NO policies: PostgREST is denied outright.
-- The app is unaffected because it connects as the table owner over Postgres,
-- and owners bypass RLS.
-- ---------------------------------------------------------------
ALTER TABLE orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_availability ENABLE ROW LEVEL SECURITY;

-- Belt and braces: revoke the roles PostgREST authenticates as.
REVOKE ALL ON orders            FROM anon, authenticated;
REVOKE ALL ON order_items       FROM anon, authenticated;
REVOKE ALL ON menu_availability FROM anon, authenticated;
