// -------------------------------------------------------------
// SQLite order store.
//
// Orders live in two tables: one row per order, one row per drink in
// order_items, so per-drink sales can be reported without unpacking JSON.
// Everything is synchronous - better-sqlite3 is fast enough for a single
// counter and it keeps the request handlers free of callback juggling.
// -------------------------------------------------------------
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DATABASE_FILE || path.join(DATA_DIR, 'orders.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');   // survives an unclean shutdown mid-write
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id             TEXT PRIMARY KEY,
    customer_name  TEXT NOT NULL,
    phone          TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    total          REAL NOT NULL,
    payment_method TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    status         TEXT NOT NULL,
    latitude       REAL,
    longitude      REAL,
    distance       REAL,
    zone_name      TEXT,
    spam_risk      TEXT,
    risk_reason    TEXT,
    ip_address     TEXT,
    session_id     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL,
    name         TEXT NOT NULL,
    variant_name TEXT,
    price        REAL NOT NULL,
    quantity     INTEGER NOT NULL,
    ice          TEXT,
    sugar        TEXT,
    tea_base     TEXT,
    addons_text  TEXT
  );

  -- Only sold-out items are stored; anything absent is available. The menu
  -- itself still lives in server.js, so this survives menu edits by id.
  CREATE TABLE IF NOT EXISTS menu_availability (
    menu_item_id INTEGER PRIMARY KEY,
    available    INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_session  ON orders(session_id);
  CREATE INDEX IF NOT EXISTS idx_orders_ip       ON orders(ip_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_items_order     ON order_items(order_id);
`);

// -------------------------------------------------------------
// Row <-> app object mapping. The app speaks camelCase; SQL speaks snake_case.
// -------------------------------------------------------------
function rowToOrder(row, items) {
  if (!row) return null;
  return {
    id: row.id,
    customerName: row.customer_name,
    phone: row.phone,
    notes: row.notes,
    items: items || [],
    total: row.total,
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
    createdAt: row.created_at
  };
}

function rowToItem(row) {
  return {
    id: row.menu_item_id,
    name: row.name,
    variantName: row.variant_name,
    price: row.price,
    quantity: row.quantity,
    ice: row.ice,
    sugar: row.sugar,
    teaBase: row.tea_base,
    addonsText: row.addons_text
  };
}

const stmts = {
  insertOrder: db.prepare(`
    INSERT INTO orders (id, customer_name, phone, notes, total, payment_method,
      payment_status, status, latitude, longitude, distance, zone_name,
      spam_risk, risk_reason, ip_address, session_id, created_at, updated_at)
    VALUES (@id, @customerName, @phone, @notes, @total, @paymentMethod,
      @paymentStatus, @status, @latitude, @longitude, @distance, @zoneName,
      @spamRisk, @riskReason, @ipAddress, @sessionId, @createdAt, @createdAt)
  `),
  insertItem: db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, variant_name, price,
      quantity, ice, sugar, tea_base, addons_text)
    VALUES (@orderId, @id, @name, @variantName, @price, @quantity, @ice,
      @sugar, @teaBase, @addonsText)
  `),
  getOrder: db.prepare(`SELECT * FROM orders WHERE id = ?`),
  getItems: db.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY id`),
  listOrders: db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`),
  allItems: db.prepare(`SELECT * FROM order_items`),
  updateOrder: db.prepare(`
    UPDATE orders SET status = @status, payment_status = @paymentStatus,
      updated_at = @updatedAt WHERE id = @id
  `),
  countUnpaidForSession: db.prepare(`
    SELECT COUNT(*) AS n FROM orders
    WHERE session_id = ? AND payment_status = 'pending' AND status != 'cancelled'
  `),
  countRecentForIp: db.prepare(`
    SELECT COUNT(*) AS n FROM orders WHERE ip_address = ? AND created_at >= ?
  `),
  salesByDay: db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS orders,
           SUM(total) AS revenue
    FROM orders WHERE payment_status = 'paid' AND status = 'completed'
    GROUP BY day ORDER BY day DESC LIMIT ?
  `),
  listUnavailable: db.prepare(`SELECT menu_item_id FROM menu_availability WHERE available = 0`),
  setAvailability: db.prepare(`
    INSERT INTO menu_availability (menu_item_id, available, updated_at)
    VALUES (@id, @available, @updatedAt)
    ON CONFLICT(menu_item_id) DO UPDATE SET
      available = excluded.available, updated_at = excluded.updated_at
  `),
  topDrinks: db.prepare(`
    SELECT oi.name, SUM(oi.quantity) AS sold, SUM(oi.price * oi.quantity) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'completed'
    GROUP BY oi.name ORDER BY sold DESC LIMIT ?
  `)
};

// An order and its items must land together or not at all.
const insertOrderTx = db.transaction((order) => {
  stmts.insertOrder.run({
    id: order.id,
    customerName: order.customerName,
    phone: order.phone,
    notes: order.notes || '',
    total: order.total,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    latitude: order.latitude,
    longitude: order.longitude,
    distance: order.distance,
    zoneName: order.zoneName || null,
    spamRisk: order.spamRisk,
    riskReason: order.riskReason,
    ipAddress: order.ipAddress,
    sessionId: order.sessionId,
    createdAt: order.createdAt
  });
  for (const item of order.items) {
    stmts.insertItem.run({
      orderId: order.id,
      id: item.id,
      name: item.name,
      variantName: item.variantName,
      price: item.price,
      quantity: item.quantity,
      ice: item.ice,
      sugar: item.sugar,
      teaBase: item.teaBase,
      addonsText: item.addonsText
    });
  }
});

module.exports = {
  file: DB_FILE,

  saveOrder(order) {
    insertOrderTx(order);
    return order;
  },

  getOrder(id) {
    const row = stmts.getOrder.get(id);
    if (!row) return null;
    return rowToOrder(row, stmts.getItems.all(id).map(rowToItem));
  },

  // One query for orders and one for items, stitched in memory, so listing N
  // orders never becomes N+1 queries.
  listOrders(limit = 500) {
    const rows = stmts.listOrders.all(limit);
    const byOrder = new Map();
    for (const item of stmts.allItems.all()) {
      if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
      byOrder.get(item.order_id).push(rowToItem(item));
    }
    return rows.map(row => rowToOrder(row, byOrder.get(row.id) || []));
  },

  updateOrder(id, { status, paymentStatus }) {
    const current = stmts.getOrder.get(id);
    if (!current) return null;
    stmts.updateOrder.run({
      id,
      status: status !== undefined ? status : current.status,
      paymentStatus: paymentStatus !== undefined ? paymentStatus : current.payment_status,
      updatedAt: new Date().toISOString()
    });
    return module.exports.getOrder(id);
  },

  // Both anti-spam counters now come from the database, so they survive a
  // restart instead of resetting the moment the server is redeployed.
  countUnpaidForSession(sessionId) {
    return stmts.countUnpaidForSession.get(sessionId).n;
  },

  countRecentOrdersForIp(ip, windowMs) {
    const since = new Date(Date.now() - windowMs).toISOString();
    return stmts.countRecentForIp.get(ip, since).n;
  },

  // -----------------------------------------------------------
  // Menu availability (sold-out toggles)
  // -----------------------------------------------------------
  unavailableIds() {
    return new Set(stmts.listUnavailable.all().map(r => r.menu_item_id));
  },

  setAvailability(menuItemId, available) {
    stmts.setAvailability.run({
      id: menuItemId,
      available: available ? 1 : 0,
      updatedAt: new Date().toISOString()
    });
  },

  // -----------------------------------------------------------
  // Order history search
  //
  // Filters are composed into one WHERE clause with bound parameters - never
  // string-interpolated - so a search term cannot alter the query.
  // -----------------------------------------------------------
  searchOrders({ from, to, status, q, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = {};

    if (from) { where.push('created_at >= @from'); params.from = from + 'T00:00:00.000Z'; }
    if (to) { where.push('created_at <= @to'); params.to = to + 'T23:59:59.999Z'; }
    if (status) { where.push('status = @status'); params.status = status; }
    if (q) {
      where.push('(id LIKE @q OR customer_name LIKE @q OR phone LIKE @q)');
      params.q = '%' + q + '%';
    }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const paidClause = 'WHERE ' + where.concat("payment_status = 'paid'").join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(params).n;
    const revenue = db.prepare(
      `SELECT COALESCE(SUM(total), 0) AS sum FROM orders ${paidClause}`
    ).get(params).sum;

    const rows = db.prepare(
      `SELECT * FROM orders ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
    ).all(Object.assign({}, params, { limit: Math.min(limit, 500), offset }));

    const ids = rows.map(r => r.id);
    const byOrder = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      for (const item of db.prepare(
        `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`
      ).all(...ids)) {
        if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
        byOrder.get(item.order_id).push(rowToItem(item));
      }
    }

    return {
      total,
      revenue: Math.round(revenue * 100) / 100,
      orders: rows.map(row => rowToOrder(row, byOrder.get(row.id) || []))
    };
  },

  salesByDay(days = 30) {
    return stmts.salesByDay.all(days);
  },

  topDrinks(limit = 20) {
    return stmts.topDrinks.all(limit);
  },

  // One-time import of the old JSON file so nothing from before is lost.
  importLegacyJson(jsonPath) {
    if (!fs.existsSync(jsonPath)) return 0;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      console.error('Legacy orders file is unreadable, skipping import:', err.message);
      return 0;
    }
    if (!Array.isArray(parsed) || !parsed.length) return 0;

    let imported = 0;
    for (const order of parsed) {
      if (!order || !order.id || stmts.getOrder.get(order.id)) continue;
      try {
        insertOrderTx(Object.assign({ items: [], notes: '' }, order));
        imported++;
      } catch (err) {
        console.error(`Could not import order ${order.id}:`, err.message);
      }
    }
    if (imported) {
      fs.renameSync(jsonPath, jsonPath + '.imported');
      console.log(`Imported ${imported} order(s) from the old JSON store.`);
    }
    return imported;
  },

  close() {
    db.close();
  }
};
