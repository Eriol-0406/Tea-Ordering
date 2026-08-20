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

// DATE (1082) is a calendar day with no time or zone. The driver's default is
// to build a JS Date at *local* midnight, which then shifts to the previous day
// when read back as UTC anywhere east of Greenwich - Malaysia is UTC+8, so
// every seasonal date came back a day early. Keep it as the plain string
// Postgres already sends.
types.setTypeParser(1082, value => value);

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

// Today in the server's local calendar, matching how Postgres reads CURRENT_DATE.
function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

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
    lineId: row.id,
    id: row.menu_item_id,
    name: row.name,
    variantId: row.variant_id,
    variantName: row.variant_name,
    basePrice: row.base_price === null ? null : Number(row.base_price),
    price: Number(row.price),
    quantity: row.quantity,
    category: row.category,
    company: row.company,
    modifiersText: row.modifiers_text || '',
    modifiers: []
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

  const lines = new Map();
  for (const row of rows) {
    const item = rowToItem(row);
    lines.set(row.id, item);
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(item);
  }

  if (lines.size) {
    const mods = await query(
      'SELECT * FROM order_item_modifiers WHERE order_item_id = ANY($1::bigint[]) ORDER BY id',
      [[...lines.keys()]]
    );
    for (const m of mods.rows) {
      const line = lines.get(Number(m.order_item_id));
      if (line) line.modifiers.push({
        groupName: m.group_name,
        optionName: m.option_name,
        priceDelta: Number(m.price_delta)
      });
    }
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
        const line = await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name, variant_id, variant_name,
             base_price, price, quantity, category, company, modifiers_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [order.id, item.id, item.name, item.variantId || null, item.variantName,
           item.basePrice ?? null, item.price, item.quantity,
           item.category || null, item.company || null, item.modifiersText || '']
        );
        const lineId = line.rows[0].id;

        // Option names and prices are copied, not referenced, so editing the
        // menu later never rewrites what a customer was actually charged.
        for (const m of (item.modifiers || [])) {
          await client.query(
            `INSERT INTO order_item_modifiers (order_item_id, group_id, option_id,
               group_name, option_name, price_delta)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [lineId, m.groupId, m.optionId, m.groupName, m.optionName, m.priceDelta]
          );
        }
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
    const byOrder = await itemsFor([id]);
    return rowToOrder(rows[0], byOrder.get(id) || []);
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
  // Menu
  //
  // Four flat queries stitched in memory rather than one big join, which would
  // multiply rows across variants x options and need de-duplicating.
  // -----------------------------------------------------------
  async getMenu({ includeInactive = false } = {}) {
    // Out-of-season drinks disappear from the customer menu on their own.
    // Staff still see them, flagged, so they can be brought back next year.
    const activeOnly = includeInactive ? '' : `
      AND i.is_active AND c.is_active
      AND (i.available_from  IS NULL OR i.available_from  <= CURRENT_DATE)
      AND (i.available_until IS NULL OR i.available_until >= CURRENT_DATE)`;

    const [items, variants, groups, options, catLinks, itemLinks, soldOut] = await Promise.all([
      query(`SELECT i.id, i.name, i.description, i.image_url, i.image_id,
                    i.available_from, i.available_until, i.sort_order, i.is_active,
                    c.id AS category_id, c.name AS category, c.name_zh AS category_zh,
                    c.sort_order AS category_sort, co.code AS company
               FROM menu_items i
               JOIN menu_categories c ON c.id = i.category_id
               JOIN companies co ON co.id = c.company_id
              WHERE TRUE ${activeOnly}
              ORDER BY c.sort_order, i.sort_order, i.id`),
      query('SELECT * FROM menu_variants WHERE is_active ORDER BY item_id, sort_order, id'),
      query('SELECT * FROM modifier_groups WHERE is_active ORDER BY sort_order, id'),
      query('SELECT * FROM modifier_options WHERE is_active ORDER BY group_id, sort_order, id'),
      query('SELECT * FROM category_modifier_groups'),
      query('SELECT * FROM item_modifier_groups'),
      query('SELECT menu_item_id FROM menu_availability WHERE available = false')
    ]);

    const soldOutIds = new Set(soldOut.rows.map(r => r.menu_item_id));

    const optionsByGroup = new Map();
    for (const o of options.rows) {
      if (!optionsByGroup.has(o.group_id)) optionsByGroup.set(o.group_id, []);
      optionsByGroup.get(o.group_id).push({
        id: o.id,
        name: o.name,
        nameZh: o.name_zh,
        priceDelta: Number(o.price_delta),
        isDefault: o.is_default
      });
    }

    const groupById = new Map();
    for (const g of groups.rows) {
      groupById.set(g.id, {
        id: g.id,
        name: g.name,
        nameZh: g.name_zh,
        selection: g.selection,
        required: g.is_required,
        sortOrder: g.sort_order,
        options: optionsByGroup.get(g.id) || []
      });
    }

    const groupsForCategory = new Map();
    for (const link of catLinks.rows) {
      if (!groupsForCategory.has(link.category_id)) groupsForCategory.set(link.category_id, []);
      groupsForCategory.get(link.category_id).push(link.group_id);
    }
    const groupsForItem = new Map();
    for (const link of itemLinks.rows) {
      if (!groupsForItem.has(link.item_id)) groupsForItem.set(link.item_id, []);
      groupsForItem.get(link.item_id).push(link.group_id);
    }

    const variantsByItem = new Map();
    for (const v of variants.rows) {
      if (!variantsByItem.has(v.item_id)) variantsByItem.set(v.item_id, []);
      variantsByItem.get(v.item_id).push({ id: v.id, name: v.name, price: Number(v.price) });
    }

    return items.rows.map(row => {
      const ids = new Set([
        ...(groupsForCategory.get(row.category_id) || []),
        ...(groupsForItem.get(row.id) || [])
      ]);
      const modifierGroups = [...ids]
        .map(id => groupById.get(id))
        .filter(Boolean)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        categoryZh: row.category_zh,
        categoryId: row.category_id,
        company: row.company,
        // Uploaded images win over the legacy file path.
        image: row.image_id ? `/api/images/${row.image_id}` : (row.image_url || undefined),
        imageId: row.image_id ? Number(row.image_id) : null,
        availableFrom: row.available_from || null,
        availableUntil: row.available_until || null,
        // Both sides are YYYY-MM-DD, so a string comparison is a date comparison.
        expired: !!(row.available_until && row.available_until < todayIso()),
        sortOrder: row.sort_order,
        isActive: row.is_active,
        available: !soldOutIds.has(row.id),
        variants: variantsByItem.get(row.id) || [],
        modifierGroups
      };
    });
  },

  async listCategories() {
    const { rows } = await query(
      `SELECT c.*, co.code AS company FROM menu_categories c
         JOIN companies co ON co.id = c.company_id
        ORDER BY c.sort_order, c.id`
    );
    return rows.map(r => ({
      id: r.id, name: r.name, nameZh: r.name_zh, company: r.company,
      companyId: r.company_id, sortOrder: r.sort_order, isActive: r.is_active
    }));
  },

  // -----------------------------------------------------------
  // Menu administration
  //
  // Deleting an item that appears in past orders would leave history pointing
  // at nothing, so anything already sold is archived (hidden) rather than
  // removed. Genuinely unused items are deleted outright.
  // -----------------------------------------------------------
  async createItem({ categoryId, name, description, imageUrl, variants }) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO menu_items (category_id, name, description, image_url, sort_order)
         VALUES ($1,$2,$3,$4, COALESCE((SELECT MAX(sort_order)+1 FROM menu_items), 1))
         RETURNING id`,
        [categoryId, name, description || '', imageUrl || null]
      );
      const id = rows[0].id;
      for (let i = 0; i < variants.length; i++) {
        await client.query(
          `INSERT INTO menu_variants (item_id, name, price, sort_order) VALUES ($1,$2,$3,$4)`,
          [id, variants[i].name, variants[i].price, i + 1]
        );
      }
      await client.query('COMMIT');
      return id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  async updateItem(id, fields) {
    const sets = [];
    const params = [id];
    const map = {
      name: 'name', description: 'description', imageUrl: 'image_url',
      imageId: 'image_id', availableFrom: 'available_from',
      availableUntil: 'available_until', categoryId: 'category_id',
      isActive: 'is_active', sortOrder: 'sort_order'
    };
    for (const [key, column] of Object.entries(map)) {
      if (fields[key] === undefined) continue;
      params.push(fields[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return false;
    sets.push('updated_at = now()');
    const { rowCount } = await query(
      `UPDATE menu_items SET ${sets.join(', ')} WHERE id = $1`, params
    );
    return rowCount > 0;
  },

  async deleteItem(id) {
    const used = await query(
      'SELECT 1 FROM order_items WHERE menu_item_id = $1 LIMIT 1', [id]
    );
    if (used.rowCount) {
      await query('UPDATE menu_items SET is_active = false, updated_at = now() WHERE id = $1', [id]);
      return { archived: true };
    }
    const { rowCount } = await query('DELETE FROM menu_items WHERE id = $1', [id]);
    return { deleted: rowCount > 0 };
  },

  async addVariant(itemId, { name, price }) {
    const { rows } = await query(
      `INSERT INTO menu_variants (item_id, name, price, sort_order)
       VALUES ($1,$2,$3, COALESCE((SELECT MAX(sort_order)+1 FROM menu_variants WHERE item_id = $1), 1))
       RETURNING id`,
      [itemId, name, price]
    );
    return rows[0].id;
  },

  async updateVariant(id, { name, price, isActive }) {
    const sets = [];
    const params = [id];
    if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
    if (price !== undefined) { params.push(price); sets.push(`price = $${params.length}`); }
    if (isActive !== undefined) { params.push(isActive); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return false;
    const { rowCount } = await query(`UPDATE menu_variants SET ${sets.join(', ')} WHERE id = $1`, params);
    return rowCount > 0;
  },

  async deleteVariant(id) {
    // A drink must keep at least one size, or it becomes unorderable.
    const { rows } = await query(
      `SELECT item_id, (SELECT COUNT(*)::int FROM menu_variants v2
                         WHERE v2.item_id = v.item_id AND v2.is_active) AS siblings
         FROM menu_variants v WHERE id = $1`, [id]
    );
    if (!rows.length) return { notFound: true };
    if (rows[0].siblings <= 1) return { lastOne: true };
    await query('DELETE FROM menu_variants WHERE id = $1', [id]);
    return { deleted: true };
  },

  // ---- modifier groups ----
  async listModifiers() {
    const [groups, options, catLinks, itemLinks] = await Promise.all([
      query('SELECT * FROM modifier_groups ORDER BY sort_order, id'),
      query('SELECT * FROM modifier_options ORDER BY group_id, sort_order, id'),
      query('SELECT * FROM category_modifier_groups'),
      query('SELECT * FROM item_modifier_groups')
    ]);

    return groups.rows.map(g => ({
      id: g.id,
      name: g.name,
      nameZh: g.name_zh,
      selection: g.selection,
      required: g.is_required,
      sortOrder: g.sort_order,
      isActive: g.is_active,
      options: options.rows.filter(o => o.group_id === g.id).map(o => ({
        id: o.id, name: o.name, nameZh: o.name_zh,
        priceDelta: Number(o.price_delta), isDefault: o.is_default, isActive: o.is_active
      })),
      categoryIds: catLinks.rows.filter(l => l.group_id === g.id).map(l => l.category_id),
      itemIds: itemLinks.rows.filter(l => l.group_id === g.id).map(l => l.item_id)
    }));
  },

  async createGroup({ name, nameZh, selection, required }) {
    const { rows } = await query(
      `INSERT INTO modifier_groups (name, name_zh, selection, is_required, sort_order)
       VALUES ($1,$2,$3,$4, COALESCE((SELECT MAX(sort_order)+1 FROM modifier_groups), 1))
       RETURNING id`,
      [name, nameZh || null, selection, !!required]
    );
    return rows[0].id;
  },

  async updateGroup(id, fields) {
    const sets = [];
    const params = [id];
    const map = { name: 'name', nameZh: 'name_zh', selection: 'selection',
                  required: 'is_required', isActive: 'is_active', sortOrder: 'sort_order' };
    for (const [key, column] of Object.entries(map)) {
      if (fields[key] === undefined) continue;
      params.push(fields[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return false;
    const { rowCount } = await query(`UPDATE modifier_groups SET ${sets.join(', ')} WHERE id = $1`, params);
    return rowCount > 0;
  },

  async deleteGroup(id) {
    const { rowCount } = await query('DELETE FROM modifier_groups WHERE id = $1', [id]);
    return rowCount > 0;
  },

  async addOption(groupId, { name, nameZh, priceDelta, isDefault }) {
    const { rows } = await query(
      `INSERT INTO modifier_options (group_id, name, name_zh, price_delta, is_default, sort_order)
       VALUES ($1,$2,$3,$4,$5, COALESCE((SELECT MAX(sort_order)+1 FROM modifier_options WHERE group_id = $1), 1))
       RETURNING id`,
      [groupId, name, nameZh || null, priceDelta || 0, !!isDefault]
    );
    return rows[0].id;
  },

  async updateOption(id, fields) {
    const sets = [];
    const params = [id];
    const map = { name: 'name', nameZh: 'name_zh', priceDelta: 'price_delta',
                  isDefault: 'is_default', isActive: 'is_active' };
    for (const [key, column] of Object.entries(map)) {
      if (fields[key] === undefined) continue;
      params.push(fields[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return false;
    const { rowCount } = await query(`UPDATE modifier_options SET ${sets.join(', ')} WHERE id = $1`, params);
    return rowCount > 0;
  },

  async deleteOption(id) {
    const { rowCount } = await query('DELETE FROM modifier_options WHERE id = $1', [id]);
    return rowCount > 0;
  },

  // Replaces a group's assignments wholesale - simpler to reason about than
  // diffing, and these lists are tiny.
  async setGroupAssignments(groupId, { categoryIds = [], itemIds = [] }) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM category_modifier_groups WHERE group_id = $1', [groupId]);
      await client.query('DELETE FROM item_modifier_groups WHERE group_id = $1', [groupId]);
      for (const cid of categoryIds) {
        await client.query('INSERT INTO category_modifier_groups (category_id, group_id) VALUES ($1,$2)', [cid, groupId]);
      }
      for (const iid of itemIds) {
        await client.query('INSERT INTO item_modifier_groups (item_id, group_id) VALUES ($1,$2)', [iid, groupId]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  // -----------------------------------------------------------
  // Uploaded images
  // -----------------------------------------------------------
  async saveImage({ mimeType, buffer, width, height }) {
    const { rows } = await query(
      `INSERT INTO menu_images (mime_type, bytes, byte_size, width, height)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [mimeType, buffer, buffer.length, width || null, height || null]
    );
    return Number(rows[0].id);
  },

  async getImage(id) {
    const { rows } = await query(
      'SELECT mime_type, bytes FROM menu_images WHERE id = $1', [id]
    );
    if (!rows.length) return null;
    return { mimeType: rows[0].mime_type, bytes: rows[0].bytes };
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
