// -------------------------------------------------------------
// Postgres order store (Supabase).
//
// Every method is async and returns the same shapes the app used under SQLite,
// so callers only had to gain `await`.
//
// Connection notes:
//  - DATABASE_URL should be Supabase's *transaction* pooler (port 6543).
//    Serverless opens a connection per invocation, which is what it is for.
//  - node-postgres sends unnamed prepared statements, which pgBouncer's
//    transaction mode supports. Do not switch to named statements.
//  - The pool is deliberately tiny: many short-lived function instances each
//    holding a big pool would exhaust the pooler.
// -------------------------------------------------------------
const { Pool, types } = require('pg');

const MISSING_URL_MESSAGE =
  'DATABASE_URL is not set. Copy the Supabase "Transaction pooler" connection ' +
  'string (port 6543) into .env for local use, and add it to the host\'s ' +
  'environment variables for deployment. Schema: migrations/001_init_postgres.sql';

// NUMERIC arrives as a string by default, which would turn RM totals into
// string concatenation the first time anything added them up.
types.setTypeParser(1700, parseFloat);

// The pool is built on first use rather than at import. Throwing while a
// serverless platform is importing the module takes down every route with an
// opaque FUNCTION_INVOCATION_FAILED; failing at query time instead surfaces a
// readable error and leaves the menu, health check and static pages working.
let pool = null;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new Error(MISSING_URL_MESSAGE);

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: parseInt(process.env.DB_POOL_MAX || '3', 10),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000
  });

  pool.on('error', (err) => {
    console.error('Idle Postgres client error:', err.message);
  });

  return pool;
}

const query = (text, params) => getPool().query(text, params);

// -------------------------------------------------------------
// Row <-> app object mapping
// -------------------------------------------------------------
function rowToOrder(row, items) {
  if (!row) return null;
  return {
    id: row.id,
    customerName: row.customer_name,
    phone: row.phone,
    notes: row.notes,
    items: items || [],
    total: Number(row.total),
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    latitude: row.latitude,
    longitude: row.longitude,
    distance: row.distance,
    zoneName: row.zone_name,
    spamRisk: row.spam_risk,
    riskReason: row.risk_reason,
    ipAddress: row.ip_address,
    sessionId: row.session_id,
    // The app and the frontend both speak ISO strings.
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function rowToItem(row) {
  return {
    id: row.menu_item_id,
    name: row.name,
    variantName: row.variant_name,
    price: Number(row.price),
    quantity: row.quantity,
    ice: row.ice,
    sugar: row.sugar,
    teaBase: row.tea_base,
    addonsText: row.addons_text
  };
}

// Groups line items by order id in one pass, so listing N orders stays two
// queries rather than N+1.
async function itemsFor(orderIds) {
  const byOrder = new Map();
  if (!orderIds.length) return byOrder;

  const { rows } = await query(
    'SELECT * FROM order_items WHERE order_id = ANY($1::text[]) ORDER BY id',
    [orderIds]
  );
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(rowToItem(row));
  }
  return byOrder;
}

module.exports = {
  describe: 'Supabase Postgres',

  // -----------------------------------------------------------
  // Orders
  // -----------------------------------------------------------
  async saveOrder(order) {
    // An order and its line items must land together, so they share one
    // client and one transaction.
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO orders (id, customer_name, phone, notes, total, payment_method,
           payment_status, status, latitude, longitude, distance, zone_name,
           spam_risk, risk_reason, ip_address, session_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
        [order.id, order.customerName, order.phone, order.notes || '', order.total,
         order.paymentMethod, order.paymentStatus, order.status, order.latitude,
         order.longitude, order.distance, order.zoneName || null, order.spamRisk,
         order.riskReason, order.ipAddress, order.sessionId, order.createdAt]
      );

      for (const item of order.items) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name, variant_name,
             price, quantity, ice, sugar, tea_base, addons_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [order.id, item.id, item.name, item.variantName, item.price,
           item.quantity, item.ice, item.sugar, item.teaBase, item.addonsText]
        );
      }

      await client.query('COMMIT');
      return order;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  async getOrder(id) {
    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!rows.length) return null;
    const items = await query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
    return rowToOrder(rows[0], items.rows.map(rowToItem));
  },

  async listOrders(limit = 500) {
    const { rows } = await query(
      'SELECT * FROM orders ORDER BY created_at DESC LIMIT $1',
      [Math.min(limit, 2000)]
    );
    const byOrder = await itemsFor(rows.map(r => r.id));
    return rows.map(r => rowToOrder(r, byOrder.get(r.id) || []));
  },

  async updateOrder(id, { status, paymentStatus }) {
    const { rows } = await query(
      `UPDATE orders
          SET status         = COALESCE($2, status),
              payment_status = COALESCE($3, payment_status),
              updated_at     = now()
        WHERE id = $1
        RETURNING id`,
      [id, status === undefined ? null : status, paymentStatus === undefined ? null : paymentStatus]
    );
    if (!rows.length) return null;
    return module.exports.getOrder(id);
  },

  // -----------------------------------------------------------
  // Anti-spam counters, derived from the data rather than memory
  // -----------------------------------------------------------
  async countUnpaidForSession(sessionId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE session_id = $1 AND payment_status = 'pending' AND status <> 'cancelled'`,
      [sessionId]
    );
    return rows[0].n;
  },

  async countRecentOrdersForIp(ip, windowMs) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE ip_address = $1 AND created_at >= now() - ($2::bigint * interval '1 millisecond')`,
      [ip, windowMs]
    );
    return rows[0].n;
  },

  // -----------------------------------------------------------
  // Menu availability
  // -----------------------------------------------------------
  async unavailableIds() {
    const { rows } = await query(
      'SELECT menu_item_id FROM menu_availability WHERE available = false'
    );
    return new Set(rows.map(r => r.menu_item_id));
  },

  async setAvailability(menuItemId, available) {
    await query(
      `INSERT INTO menu_availability (menu_item_id, available, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (menu_item_id)
       DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
      [menuItemId, !!available]
    );
  },

  // -----------------------------------------------------------
  // History search. Filters are bound parameters, never interpolated.
  // -----------------------------------------------------------
  async searchOrders({ from, to, status, q, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (from) { params.push(from); where.push(`created_at >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`created_at < ($${params.length}::date + interval '1 day')`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (q) { params.push('%' + q + '%'); where.push(`(id ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR phone ILIKE $${params.length})`); }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const paidClause = 'WHERE ' + where.concat("payment_status = 'paid'").join(' AND ');

    const totals = await query(
      `SELECT (SELECT COUNT(*)::int FROM orders ${clause}) AS total,
              (SELECT COALESCE(SUM(total), 0) FROM orders ${paidClause}) AS revenue`,
      params
    );

    const pageParams = params.concat([Math.min(limit, 500), offset]);
    const { rows } = await query(
      `SELECT * FROM orders ${clause}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      pageParams
    );

    const byOrder = await itemsFor(rows.map(r => r.id));

    return {
      total: totals.rows[0].total,
      revenue: Math.round(Number(totals.rows[0].revenue) * 100) / 100,
      orders: rows.map(r => rowToOrder(r, byOrder.get(r.id) || []))
    };
  },

  // -----------------------------------------------------------
  // Reporting
  // -----------------------------------------------------------
  async salesByDay(days = 30) {
    const { rows } = await query(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS orders,
              SUM(total) AS revenue
         FROM orders
        WHERE payment_status = 'paid' AND status = 'completed'
        GROUP BY day
        ORDER BY day DESC
        LIMIT $1`,
      [days]
    );
    return rows.map(r => ({ day: r.day, orders: r.orders, revenue: Number(r.revenue) }));
  },

  async topDrinks(limit = 20) {
    const { rows } = await query(
      `SELECT oi.name,
              SUM(oi.quantity)::int AS sold,
              SUM(oi.price * oi.quantity) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'completed'
        GROUP BY oi.name
        ORDER BY sold DESC
        LIMIT $1`,
      [limit]
    );
    return rows.map(r => ({ name: r.name, sold: r.sold, revenue: Number(r.revenue) }));
  },

  // Reports config health without leaking any values.
  async health() {
    const configured = !!process.env.DATABASE_URL;
    if (!configured) return { configured: false, reachable: false, error: MISSING_URL_MESSAGE };
    try {
      const { rows } = await query('SELECT 1 AS ok');
      return { configured: true, reachable: rows[0].ok === 1 };
    } catch (err) {
      // Driver errors can embed the connection string.
      const safe = String(err.message).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]');
      return { configured: true, reachable: false, error: safe };
    }
  },

  async close() {
    if (pool) await pool.end();
  }
};
