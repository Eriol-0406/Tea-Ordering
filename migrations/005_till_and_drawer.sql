-- Counter till, discounts, voids and the cash drawer.
--
-- Concepts this introduces, and why each is separate:
--   * shift        - a period the drawer is open. Cash only reconciles within one.
--   * void         - reversing a sale that was already made or paid. Distinct
--                    from 'cancelled', which means the drink was never made.
--                    A void must stay visible in reports; silently deleting a
--                    sale is how till fraud hides.
--   * discount     - stored as its own amount, never folded into the price, so
--                    gross sales and discounts can both be reported honestly.

-- ---------------------------------------------------------------
-- Shifts (the drawer)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by      TEXT NOT NULL,
  opening_float  NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  closed_at      TIMESTAMPTZ,
  closed_by      TEXT,
  counted_cash   NUMERIC(10,2),
  expected_cash  NUMERIC(10,2),
  variance       NUMERIC(10,2),
  notes          TEXT NOT NULL DEFAULT ''
);

-- Only one drawer open at a time, or cash cannot be attributed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_shift
  ON shifts ((closed_at IS NULL)) WHERE closed_at IS NULL;

-- Paid in / paid out: float top-ups, supplier payments, bankings.
CREATE TABLE IF NOT EXISTS cash_movements (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id   BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount     NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL DEFAULT 'staff'
);

CREATE INDEX IF NOT EXISTS idx_cash_shift ON cash_movements (shift_id);

-- ---------------------------------------------------------------
-- Orders gain till, discount and void information
-- ---------------------------------------------------------------
ALTER TABLE orders
  -- 'customer' = ordered on a phone by QR, 'till' = rung up at the counter.
  ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS order_type      TEXT NOT NULL DEFAULT 'takeaway',
  ADD COLUMN IF NOT EXISTS shift_id        BIGINT REFERENCES shifts(id),
  ADD COLUMN IF NOT EXISTS staff_name      TEXT,

  -- Gross is the menu value before any reduction; total stays the amount due.
  ADD COLUMN IF NOT EXISTS gross_total     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason TEXT,

  -- Cash handling, needed to reconcile the drawer.
  ADD COLUMN IF NOT EXISTS cash_received   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cash_change     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS paid_at         TIMESTAMPTZ,

  -- A void is recorded, never erased.
  ADD COLUMN IF NOT EXISTS voided_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by       TEXT,
  ADD COLUMN IF NOT EXISTS void_reason     TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_shift  ON orders (shift_id);
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders (source);
CREATE INDEX IF NOT EXISTS idx_orders_paid   ON orders (paid_at);

-- Existing rows predate the split, so gross equals total with no discount.
UPDATE orders SET gross_total = total WHERE gross_total IS NULL;

ALTER TABLE shifts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON shifts, cash_movements FROM anon, authenticated;
