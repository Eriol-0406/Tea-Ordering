// One-time seed: moves the previously hardcoded menu into the database, and
// turns the hardcoded modifier conditionals into real modifier groups.
// Idempotent - re-running replaces the menu tables but leaves orders alone.
const { Pool } = require('pg');
const menuItems = require('../menu-seed.js');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Which brand each category belongs to. Drives the line-item revenue split.
const CATEGORY_COMPANY = {
  'Milk Tea': 1, 'Fruit Tea': 1, 'Pure Tea': 1, 'Cold Brew': 1, 'Smoothie': 1,
  'Coffee': 2, 'Non-Coffee': 2, 'Matcha': 2
};

const CATEGORY_ZH = {
  'Milk Tea': '奶茶', 'Fruit Tea': '水果茶', 'Pure Tea': '纯茶', 'Cold Brew': '冷泡茶',
  'Smoothie': '冰沙', 'Coffee': '咖啡系列', 'Non-Coffee': '非咖啡系列', 'Matcha': '抹茶系列'
};

// The modifier groups that were previously if-statements in server.js.
const GROUPS = [
  {
    key: 'ice', name: 'Ice Level', name_zh: '冰量', selection: 'single', required: true, sort: 1,
    // Blended drinks have no ice choice, which was a hardcoded exception.
    categories: ['Milk Tea', 'Fruit Tea', 'Pure Tea', 'Cold Brew', 'Coffee', 'Non-Coffee', 'Matcha'],
    options: [
      { name: 'Normal', name_zh: '正常', delta: 0, def: true },
      { name: 'Less Ice', name_zh: '少冰', delta: 0 },
      { name: 'No Ice', name_zh: '去冰', delta: 0 }
    ]
  },
  {
    key: 'sugar', name: 'Sugar Level', name_zh: '甜度', selection: 'single', required: true, sort: 2,
    categories: Object.keys(CATEGORY_COMPANY),
    options: [
      { name: 'Normal', name_zh: '正常', delta: 0, def: true },
      { name: 'Less (70%)', name_zh: '少糖', delta: 0 },
      { name: 'Half (50%)', name_zh: '半糖', delta: 0 },
      { name: 'Slight (30%)', name_zh: '微糖', delta: 0 },
      { name: 'No Sugar', name_zh: '无糖', delta: 0 }
    ]
  },
  {
    key: 'boba', name: 'Add On', name_zh: '附加', selection: 'multi', required: false, sort: 3,
    categories: ['Milk Tea', 'Fruit Tea', 'Pure Tea', 'Smoothie'],
    options: [{ name: 'Crystal Boba', name_zh: '晶露波波', delta: 2.00 }]
  },
  {
    key: 'espresso', name: 'Coffee Extras', name_zh: '咖啡附加', selection: 'multi', required: false, sort: 4,
    categories: ['Coffee'],
    options: [{ name: 'Extra Espresso Shot', name_zh: '加浓缩咖啡', delta: 2.50 }]
  },
  {
    key: 'matcha', name: 'Niko Neko Matcha Upgrade', name_zh: '抹茶升级', selection: 'single', required: false, sort: 5,
    categories: ['Matcha'],
    options: [
      { name: 'None', name_zh: '无', delta: 0, def: true },
      { name: 'Yuri', name_zh: 'Yuri', delta: 2.00 },
      { name: 'Ajisai', name_zh: 'Ajisai', delta: 3.00 }
    ]
  },
  {
    key: 'teabase', name: 'Tea Base', name_zh: '茶底', selection: 'single', required: true, sort: 6,
    categories: [],
    itemIds: [9], // Lemon Tea was the only item offering a base choice
    options: [
      { name: 'Da Hong Pao', name_zh: '大红袍', delta: 0, def: true },
      { name: 'White Peach Oolong', name_zh: '白桃乌龙', delta: 0 }
    ]
  }
];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Wipe menu tables only. Orders and their line items are untouched: they
    // store item names and prices as sold, not foreign keys into the menu.
    await client.query(`TRUNCATE item_modifier_groups, category_modifier_groups,
      modifier_options, modifier_groups, menu_variants, menu_items, menu_categories
      RESTART IDENTITY CASCADE`);

    // --- categories, in menu-board order ---
    const catId = {};
    const catOrder = ['Milk Tea', 'Fruit Tea', 'Pure Tea', 'Cold Brew', 'Smoothie', 'Coffee', 'Non-Coffee', 'Matcha'];
    for (let i = 0; i < catOrder.length; i++) {
      const name = catOrder[i];
      const { rows } = await client.query(
        `INSERT INTO menu_categories (name, name_zh, company_id, sort_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [name, CATEGORY_ZH[name], CATEGORY_COMPANY[name], i + 1]
      );
      catId[name] = rows[0].id;
    }

    // --- items and variants, keeping their original ids ---
    for (let i = 0; i < menuItems.length; i++) {
      const it = menuItems[i];
      await client.query(
        `INSERT INTO menu_items (id, category_id, name, description, image_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [it.id, catId[it.category], it.name, it.description || '', it.image || null, i + 1]
      );
      for (let v = 0; v < it.variants.length; v++) {
        await client.query(
          `INSERT INTO menu_variants (item_id, name, price, sort_order) VALUES ($1,$2,$3,$4)`,
          [it.id, it.variants[v].name, it.variants[v].price, v + 1]
        );
      }
    }
    // Explicit ids were inserted, so the identity sequence must catch up or the
    // first item added through the admin UI would collide.
    await client.query(`SELECT setval(pg_get_serial_sequence('menu_items','id'),
                        (SELECT MAX(id) FROM menu_items))`);

    // --- modifier groups ---
    for (const g of GROUPS) {
      const { rows } = await client.query(
        `INSERT INTO modifier_groups (name, name_zh, selection, is_required, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [g.name, g.name_zh, g.selection, g.required, g.sort]
      );
      const gid = rows[0].id;

      for (let o = 0; o < g.options.length; o++) {
        const opt = g.options[o];
        await client.query(
          `INSERT INTO modifier_options (group_id, name, name_zh, price_delta, is_default, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [gid, opt.name, opt.name_zh, opt.delta, !!opt.def, o + 1]
        );
      }
      for (const c of (g.categories || [])) {
        await client.query(
          `INSERT INTO category_modifier_groups (category_id, group_id) VALUES ($1,$2)`,
          [catId[c], gid]
        );
      }
      for (const id of (g.itemIds || [])) {
        await client.query(
          `INSERT INTO item_modifier_groups (item_id, group_id) VALUES ($1,$2)`, [id, gid]
        );
      }
    }

    await client.query('COMMIT');

    const counts = await client.query(`
      SELECT (SELECT COUNT(*) FROM menu_categories) categories,
             (SELECT COUNT(*) FROM menu_items) items,
             (SELECT COUNT(*) FROM menu_variants) variants,
             (SELECT COUNT(*) FROM modifier_groups) groups,
             (SELECT COUNT(*) FROM modifier_options) options`);
    console.log('seeded:', counts.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(e => {
  console.error('seed failed:', String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]'));
  process.exit(1);
});
