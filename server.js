const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

// -------------------------------------------------------------
// Configuration (override via environment variables)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// Ordering zones (shop + any satellite pickup points) come from config/zones.json.
// Env vars still win for the shop coordinate so a host dashboard can override it.
const zoneConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'zones.json'), 'utf8'));
const MAX_SERVICE_RADIUS_KM = zoneConfig.maxServiceRadiusKm || 25;

const ORDER_ZONES = (zoneConfig.zones || []).filter(zone => {
  if (Number.isFinite(zone.lat) && Number.isFinite(zone.lng)) return true;
  console.warn(`Zone "${zone.name}" has no coordinates yet - it is disabled until lat/lng are filled in (config/zones.json).`);
  return false;
});

const shopZone = ORDER_ZONES.find(z => z.isShop) || ORDER_ZONES[0];
if (!shopZone) throw new Error('No usable ordering zone configured in config/zones.json');

const RESTAURANT_LAT = parseFloat(process.env.RESTAURANT_LAT || shopZone.lat);
const RESTAURANT_LNG = parseFloat(process.env.RESTAURANT_LNG || shopZone.lng);
if (process.env.RESTAURANT_LAT) shopZone.lat = RESTAURANT_LAT;
if (process.env.RESTAURANT_LNG) shopZone.lng = RESTAURANT_LNG;

// Staff password for the admin console. Generated at boot if unset so the panel
// is never silently open; the generated value is printed to the server log.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
const ADMIN_PASSWORD_IS_GENERATED = !process.env.ADMIN_PASSWORD;

// Flip to 'true' only once a real payment gateway confirms funds server-side
// (see the webhook stub near /api/payments/webhook). While this is false, no
// order is money-committed, so every order gets strict proximity rules.
const PAYMENT_GATEWAY_ENABLED = process.env.PAYMENT_GATEWAY_ENABLED === 'true';

// Exposes the "Mock GPS" testing dropdown in the checkout flow.
const ENABLE_MOCK_GPS = process.env.ENABLE_MOCK_GPS === 'true' || process.env.NODE_ENV !== 'production';

// Number of reverse proxies in front of this app (Cloudflare/nginx/Render = 1).
// Without this, req.ip is the proxy's address and every customer shares one
// rate-limit bucket.
const TRUST_PROXY = process.env.TRUST_PROXY || '0';
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? parseInt(TRUST_PROXY, 10) : TRUST_PROXY);

app.use('/api/admin/images', express.json({ limit: '3mb' }));
app.use(express.json({ limit: '100kb' }));
// Filenames are not content-hashed, so only images (which rarely change and
// carry the real page weight) get a long cache. HTML/CSS/JS revalidate on every
// load via ETag, so a deploy takes effect immediately instead of leaving
// customers on stale code for an hour.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Categorized Menu Database in Ringgit Malaysia (RM)
// The menu now lives in the database (see migrations/002 and scripts/seed-menu.js).
// It is cached briefly so a burst of menu requests does not become a burst of
// queries, while an edit still shows up within a few seconds.
const MENU_CACHE_MS = 5000;
let menuCache = null;
let menuCachedAt = 0;

async function getMenu() {
  if (menuCache && Date.now() - menuCachedAt < MENU_CACHE_MS) return menuCache;
  menuCache = await store.getMenu();
  menuCachedAt = Date.now();
  return menuCache;
}

function invalidateMenuCache() {
  menuCache = null;
}

// -------------------------------------------------------------
// Order storage (SQLite - see db.js)
// -------------------------------------------------------------
const store = require('./db');

function shutdown(signal) {
  store.close().catch(() => {});
  console.log(`${signal} received - database closed. Bye.`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// -------------------------------------------------------------
// Anti-spam limits. Both counters are derived from the database, so a restart
// no longer wipes someone's rate limit or their outstanding unpaid orders.
// -------------------------------------------------------------
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ORDERS_PER_WINDOW = 4;

setInterval(() => {
  pruneLoginAttempts();
}, 10 * 60 * 1000).unref();

// -------------------------------------------------------------
// Admin authentication
// -------------------------------------------------------------
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map(); // ip -> [timestamps of failures]
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Admin sessions are stateless HMAC tokens rather than a server-side Map.
// On serverless every request may hit a fresh instance, so an in-memory token
// store would sign you in and then reject the very next click. The signing key
// is derived from the password, so changing ADMIN_PASSWORD invalidates every
// outstanding session.
const TOKEN_SECRET = crypto.createHash('sha256')
  .update('otea-admin-session:' + ADMIN_PASSWORD)
  .digest();

function signAdminToken(expiresAt) {
  const payload = String(expiresAt);
  const mac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}

function isValidAdminToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;

  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);

  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function pruneLoginAttempts() {
  const now = Date.now();
  for (const [ip, stamps] of loginAttempts) {
    const fresh = stamps.filter(ts => now - ts < LOGIN_WINDOW_MS);
    if (fresh.length) loginAttempts.set(ip, fresh);
    else loginAttempts.delete(ip);
  }
}

// Constant-time compare so the password cannot be recovered by timing responses.
function passwordMatches(supplied) {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const failures = (loginAttempts.get(ip) || []).filter(ts => Date.now() - ts < LOGIN_WINDOW_MS);

  if (failures.length >= MAX_LOGIN_FAILURES) {
    loginAttempts.set(ip, failures);
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
  }

  if (!passwordMatches(req.body && req.body.password)) {
    failures.push(Date.now());
    loginAttempts.set(ip, failures);
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  loginAttempts.delete(ip);
  const token = signAdminToken(Date.now() + ADMIN_TOKEN_TTL_MS);
  res.json({ success: true, token, expiresIn: ADMIN_TOKEN_TTL_MS });
});

// Stateless tokens cannot be revoked server-side, so logout simply tells the
// browser to discard it. To force everyone out, change ADMIN_PASSWORD - that
// rotates the signing key and invalidates every outstanding session.
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.json({ success: true });
});

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(2));
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// Strips control characters and length-caps a free-text field before storage.
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLength);
}

function modifierLabel(groupName, optionName, priceDelta) {
  if (priceDelta) return `${optionName} (+RM${priceDelta.toFixed(2)})`;
  return `${groupName}: ${optionName}`;
}

// Finds the ordering zone the customer is standing in, nearest first.
// Returns null when they are outside every configured zone.
function resolveZone(lat, lng) {
  let best = null;
  for (const zone of ORDER_ZONES) {
    const d = calculateDistance(zone.lat, zone.lng, lat, lng);
    if (d <= zone.radiusKm && (!best || d < best.distance)) {
      best = { zone, distance: d };
    }
  }
  return best;
}

async function getSpamRisk(distance, ip, sessionId, zoneName) {
  let riskLevel = 'Safe';
  let reason = zoneName ? `Verified inside ${zoneName}` : 'Location verified within range';

  if (distance === null) {
    riskLevel = 'Medium Risk';
    reason = 'No geolocation coordinates provided';
  } else if (!zoneName) {
    riskLevel = 'High Risk';
    reason = `Outside every ordering zone (${distance} km from shop)`;
  }

  if (await store.countRecentOrdersForIp(ip, RATE_WINDOW_MS) >= 2) {
    riskLevel = 'High Risk';
    reason += ' + Multiple rapid orders from same IP';
  }

  if (await store.countUnpaidForSession(sessionId) >= 1) {
    riskLevel = 'High Risk';
    reason += ' + Has an unpaid outstanding order';
  }

  return { riskLevel, reason };
}

// Staff-only fields are stripped before an order reaches a customer.
function customerView(order) {
  return {
    id: order.id,
    customerName: order.customerName,
    items: order.items,
    total: order.total,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    latitude: order.latitude,
    longitude: order.longitude,
    distance: order.distance,
    notes: order.notes,
    createdAt: order.createdAt
  };
}

// Narrower still: used for lookup by ID, which anyone could guess at.
function trackingView(order) {
  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    total: order.total,
    createdAt: order.createdAt
  };
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 0. Health check.
// Deliberately reports only whether things are configured, never any values,
// so it is safe to leave public and to paste into a support conversation.
app.get('/api/health', async (req, res) => {
  const db = await store.health();
  res.status(db.reachable ? 200 : 503).json({
    ok: db.reachable,
    env: {
      DATABASE_URL: !!process.env.DATABASE_URL,
      ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
      NODE_ENV: process.env.NODE_ENV || '(unset)',
      TRUST_PROXY: process.env.TRUST_PROXY || '(unset)'
    },
    database: db,
    zones: ORDER_ZONES.map(z => z.name),
    menuItems: (await getMenu().catch(() => [])).length
  });
});

// Uploaded menu images. An id always refers to the same bytes, so this can be
// cached aggressively; replacing a picture creates a new id.
app.get('/api/images/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).end();

    const image = await store.getImage(id);
    if (!image) return res.status(404).end();

    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(image.bytes);
  } catch (err) { next(err); }
});

const ALLOWED_IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

app.post('/api/admin/images', requireAdmin, async (req, res, next) => {
  try {
    const { mimeType, dataBase64, width, height } = req.body || {};

    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      return res.status(400).json({ error: 'Images must be WebP, JPEG or PNG' });
    }
    if (typeof dataBase64 !== 'string' || !dataBase64) {
      return res.status(400).json({ error: 'No image data received' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Image data could not be read' });
    if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'That image is too large even after resizing' });
    }

    // Trust the bytes, not the declared type: check the file signature.
    const sig = buffer.subarray(0, 12);
    const isPng  = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4E && sig[3] === 0x47;
    const isJpeg = sig[0] === 0xFF && sig[1] === 0xD8 && sig[2] === 0xFF;
    const isWebp = sig.subarray(0, 4).toString('ascii') === 'RIFF' &&
                   sig.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isPng && !isJpeg && !isWebp) {
      return res.status(400).json({ error: 'That file is not a valid image' });
    }

    const id = await store.saveImage({
      mimeType,
      buffer,
      width: parseInt(width, 10) || null,
      height: parseInt(height, 10) || null
    });
    invalidateMenuCache();
    res.status(201).json({ success: true, id, url: `/api/images/${id}` });
  } catch (err) { next(err); }
});

// 1. Get restaurant menu, annotated with what is currently sold out
app.get('/api/menu', async (req, res, next) => {
  try {
    res.json(await getMenu());
  } catch (err) { next(err); }
});

// 1b. Public runtime config for the customer app
app.get('/api/config', (req, res) => {
  res.json({
    restaurant: { lat: RESTAURANT_LAT, lng: RESTAURANT_LNG },
    // The client needs the zones to tell the customer where they can order
    // from before they reach the submit button.
    zones: ORDER_ZONES.map(z => ({
      name: z.name,
      lat: z.lat,
      lng: z.lng,
      radiusKm: z.radiusKm,
      allowCounter: z.allowCounter,
      isShop: !!z.isShop
    })),
    maxServiceRadiusKm: MAX_SERVICE_RADIUS_KM,
    enableMockGps: ENABLE_MOCK_GPS,
    paymentGatewayEnabled: PAYMENT_GATEWAY_ENABLED
  });
});

// 2. Place an order
app.post('/api/orders', async (req, res, next) => {
  try {
  const { items, paymentMethod, location } = req.body || {};
  const ipAddress = req.ip || req.socket.remoteAddress;

  const customerName = cleanText(req.body && req.body.customerName, 80);
  const phone = cleanText(req.body && req.body.phone, 25);
  const notes = cleanText(req.body && req.body.notes, 300);
  const sessionId = cleanText(req.body && req.body.sessionId, 64);

  if (!customerName || !phone || !Array.isArray(items) || !items.length || !paymentMethod || !sessionId) {
    return res.status(400).json({ error: "Missing required order details" });
  }
  if (!['counter', 'online'].includes(paymentMethod)) {
    return res.status(400).json({ error: "Unknown payment method" });
  }
  if (!/^[0-9+\-\s()]{7,25}$/.test(phone)) {
    return res.status(400).json({ error: "Please enter a valid contact number" });
  }
  if (items.length > 30) {
    return res.status(400).json({ error: "Too many distinct items in one order" });
  }

  // IP Rate Limit Check (counted from the database, so restarts do not reset it)
  if (await store.countRecentOrdersForIp(ipAddress, RATE_WINDOW_MS) >= MAX_ORDERS_PER_WINDOW) {
    return res.status(429).json({
      error: "Too many orders placed. To prevent spam, ordering is locked for 15 minutes."
    });
  }

  // Price the basket. Any rejection is a 400/409 with the reason.
  let priced;
  try {
    priced = await priceOrderItems(items);
  } catch (err) {
    if (err instanceof PriceError) {
      return res.status(err.status).json(
        Object.assign({ error: err.message }, err.soldOutItemId ? { soldOutItemId: err.soldOutItemId } : {})
      );
    }
    throw err;
  }
  const enrichedItems = priced.items;
  let total = priced.total;

  // Geolocation / Distance validation
  let distance = null;
  let hasLocation = false;
  let lat = null;
  let lng = null;

  if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng) &&
      Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180) {
    lat = location.lat;
    lng = location.lng;
    distance = calculateDistance(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng);
    hasLocation = true;
  }

  // An order is only "money-committed" once a gateway has actually confirmed
  // funds. While PAYMENT_GATEWAY_ENABLED is false the QR flow is a simulation,
  // so online orders carry the same spam exposure as counter orders and get the
  // same proximity rules.
  const paymentGuaranteed = PAYMENT_GATEWAY_ENABLED && paymentMethod === 'online';

  // Zone-based geofencing: the customer must be standing inside one of the
  // configured ordering zones, and that zone decides whether Pay at Counter is
  // offered there.
  let matchedZone = null;

  if (!hasLocation) {
    if (!paymentGuaranteed) {
      return res.status(403).json({
        error: "Location verification is required to place this order. Please enable GPS location access and try again."
      });
    }
  } else {
    if (distance > MAX_SERVICE_RADIUS_KM) {
      return res.status(403).json({
        error: `Order blocked. You are currently ${distance} km away, which is outside our ${MAX_SERVICE_RADIUS_KM} km service radius.`
      });
    }

    const match = resolveZone(lat, lng);
    if (!match && !paymentGuaranteed) {
      const zoneNames = ORDER_ZONES.map(z => z.name).join(' or ');
      return res.status(403).json({
        error: `Ordering is only available at ${zoneNames}. You appear to be ${distance} km from the shop.`
      });
    }

    if (match) {
      matchedZone = match.zone;
      if (paymentMethod === 'counter' && !matchedZone.allowCounter) {
        return res.status(403).json({
          error: `Pay at Counter is not available at ${matchedZone.name}. Please choose online payment.`
        });
      }
    }
  }

  // Session unpaid order check
  if (!paymentGuaranteed && await store.countUnpaidForSession(sessionId) >= 2) {
    return res.status(403).json({
      error: "Ordering is paused for this session due to multiple unpaid outstanding orders. Please settle them at the counter first."
    });
  }

  // Evaluate final risk score
  const zoneName = matchedZone ? matchedZone.name : null;
  const { riskLevel, reason } = await getSpamRisk(distance, ipAddress, sessionId, zoneName);

  const newOrder = {
    id: 'ORD-' + crypto.randomInt(100000, 1000000),
    customerName,
    phone,
    notes,
    items: enrichedItems,
    total: parseFloat(total.toFixed(2)),
    paymentMethod,
    // Never taken from the request body. Staff confirm payment in the console,
    // or the gateway webhook does once one is wired up.
    paymentStatus: 'pending',
    status: 'pending',
    latitude: lat,
    longitude: lng,
    distance,
    zoneName,
    spamRisk: riskLevel,
    riskReason: reason,
    ipAddress,
    sessionId,
    createdAt: new Date().toISOString()
  };

  await store.saveOrder(newOrder);

  res.status(201).json({
    success: true,
    orderId: newOrder.id,
    order: customerView(newOrder)
  });
  } catch (err) { next(err); }
});

// 3. Track customer order status
app.get('/api/orders/:id', async (req, res, next) => {
  try {
    const order = await store.getOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json(trackingView(order));
  } catch (err) { next(err); }
});

// 4. Admin fetch all orders
app.get('/api/admin/orders', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    res.json(await store.listOrders(limit));
  } catch (err) { next(err); }
});

// 4b. Admin sales reporting, straight out of the order tables
app.get('/api/admin/reports', requireAdmin, async (req, res, next) => {
  try {
    const [salesByDay, topDrinks] = await Promise.all([
      store.salesByDay(30),
      store.topDrinks(20)
    ]);
    res.json({ salesByDay, topDrinks });
  } catch (err) { next(err); }
});

// 4c. Admin: order history with filters
app.get('/api/admin/history', requireAdmin, async (req, res, next) => {
  try {
  const { from, to, status, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const validStatuses = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  res.json(await store.searchOrders({
    from: cleanText(from, 10) || null,
    to: cleanText(to, 10) || null,
    status: status || null,
    q: cleanText(q, 60) || null,
    limit,
    offset
  }));
  } catch (err) { next(err); }
});

// 4d. Admin: same query as a CSV download for spreadsheets/accounting
app.get('/api/admin/history.csv', requireAdmin, async (req, res, next) => {
  try {
  const { from, to, status, q } = req.query;
  const result = await store.searchOrders({
    from: cleanText(from, 10) || null,
    to: cleanText(to, 10) || null,
    status: status || null,
    q: cleanText(q, 60) || null,
    limit: 500,
    offset: 0
  });

  const rows = [['Order ID', 'Date', 'Customer', 'Phone', 'Zone', 'Items',
                 'Total (RM)', 'Payment', 'Payment Status', 'Status']];

  for (const o of result.orders) {
    const items = o.items.map(i => `${i.quantity}x ${i.name} (${i.variantName})`).join(' | ');
    rows.push([o.id, o.createdAt, o.customerName, o.phone, o.zoneName || '',
               items, o.total.toFixed(2), o.paymentMethod, o.paymentStatus, o.status]);
  }

  // A leading =, +, - or @ makes spreadsheets treat a cell as a formula, so
  // those are prefixed with a quote before the value is written.
  const escapeCell = (value) => {
    let text = String(value === null || value === undefined ? '' : value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };

  const csv = rows.map(r => r.map(escapeCell).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${stamp}.csv"`);
  res.send('\uFEFF' + csv); // BOM so Excel reads the Chinese drink names correctly
  } catch (err) { next(err); }
});

// 4e. Admin: mark a drink sold out / back in stock
app.post('/api/admin/menu/:id/availability', requireAdmin, async (req, res, next) => {
  try {
  const id = parseInt(req.params.id, 10);
  const item = (await getMenu()).find(m => m.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Menu item not found' });
  }
  if (typeof req.body?.available !== 'boolean') {
    return res.status(400).json({ error: 'available must be true or false' });
  }

  await store.setAvailability(id, req.body.available);
  invalidateMenuCache();

  res.json({ success: true, id, available: req.body.available });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Counter till, shifts and the cash drawer
// ---------------------------------------------------------------
const PAYMENT_METHODS = ['cash', 'duitnow', 'tng'];
const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'];

// ---- shifts ----
app.get('/api/admin/shift', requireAdmin, async (req, res, next) => {
  try {
    const shift = await store.currentShift();
    if (!shift) return res.json({ shift: null });
    const [totals, movements] = await Promise.all([
      store.shiftTotals(shift.id),
      store.listCashMovements(shift.id)
    ]);
    res.json({ shift, totals, movements });
  } catch (err) { next(err); }
});

app.post('/api/admin/shift/open', requireAdmin, async (req, res, next) => {
  try {
    const existing = await store.currentShift();
    if (existing) {
      return res.status(409).json({ error: 'A drawer is already open. Close it first.' });
    }
    const openedBy = cleanText(req.body?.openedBy, 60) || 'staff';
    const openingFloat = readPrice(req.body?.openingFloat ?? 0);
    if (openingFloat === null) return res.status(400).json({ error: 'Invalid opening float' });

    const id = await store.openShift({ openedBy, openingFloat });
    res.status(201).json({ success: true, shiftId: id });
  } catch (err) { next(err); }
});

app.post('/api/admin/shift/cash', requireAdmin, async (req, res, next) => {
  try {
    const shift = await store.currentShift();
    if (!shift) return res.status(409).json({ error: 'No drawer is open' });

    const direction = req.body?.direction === 'out' ? 'out' : 'in';
    const amount = readPrice(req.body?.amount);
    const reason = cleanText(req.body?.reason, 120);
    if (amount === null || amount <= 0) return res.status(400).json({ error: 'Enter an amount' });
    if (!reason) return res.status(400).json({ error: 'A reason is required' });

    await store.addCashMovement(shift.id, {
      direction, amount, reason, createdBy: cleanText(req.body?.by, 60) || shift.openedBy
    });
    res.json({ success: true, totals: await store.shiftTotals(shift.id) });
  } catch (err) { next(err); }
});

app.post('/api/admin/shift/close', requireAdmin, async (req, res, next) => {
  try {
    const shift = await store.currentShift();
    if (!shift) return res.status(409).json({ error: 'No drawer is open' });

    const countedCash = readPrice(req.body?.countedCash);
    if (countedCash === null) return res.status(400).json({ error: 'Enter the counted cash' });

    const totals = await store.shiftTotals(shift.id);
    const variance = await store.closeShift(shift.id, {
      closedBy: cleanText(req.body?.closedBy, 60) || shift.openedBy,
      countedCash,
      expectedCash: totals.expectedCash,
      notes: cleanText(req.body?.notes, 300)
    });

    res.json({
      success: true,
      expectedCash: totals.expectedCash,
      countedCash,
      variance,
      totals
    });
  } catch (err) { next(err); }
});

app.get('/api/admin/shifts', requireAdmin, async (req, res, next) => {
  try {
    res.json(await store.listShifts(30));
  } catch (err) { next(err); }
});

// ---- ringing up a sale at the counter ----
//
// Deliberately separate from /api/orders: geofencing, IP rate limits and
// session checks all exist to police strangers ordering remotely, and none of
// them make sense for a member of staff standing at the till.
app.post('/api/admin/till/orders', requireAdmin, async (req, res, next) => {
  try {
    const { items, paymentMethod } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'The bill is empty' });
    }
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Choose how the customer paid' });
    }

    const orderType = ORDER_TYPES.includes(req.body?.orderType) ? req.body.orderType : 'takeaway';
    const shift = await store.currentShift();
    if (!shift) {
      return res.status(409).json({ error: 'Open the drawer before taking counter orders' });
    }

    let priced;
    try {
      priced = await priceOrderItems(items);
    } catch (err) {
      if (err instanceof PriceError) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    // Discount is applied to the bill, recorded separately, and never allowed
    // to exceed the bill or turn it negative.
    const gross = priced.total;
    let discount = 0;
    const discountType = req.body?.discountType;
    if (discountType === 'percent') {
      const percent = Number(req.body?.discountValue);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        return res.status(400).json({ error: 'Discount must be between 0 and 100%' });
      }
      discount = Math.round(gross * percent) / 100;
    } else if (discountType === 'amount') {
      const value = readPrice(req.body?.discountValue);
      if (value === null) return res.status(400).json({ error: 'Invalid discount amount' });
      discount = value;
    }
    if (discount > gross) discount = gross;
    discount = Math.round(discount * 100) / 100;

    const total = Math.round((gross - discount) * 100) / 100;

    // Cash needs a tendered amount so the drawer reconciles and staff get the
    // change worked out for them.
    let cashReceived = null;
    let cashChange = null;
    if (paymentMethod === 'cash') {
      cashReceived = readPrice(req.body?.cashReceived);
      if (cashReceived === null || cashReceived < total) {
        return res.status(400).json({ error: 'Cash received is less than the amount due' });
      }
      cashChange = Math.round((cashReceived - total) * 100) / 100;
    }

    const now = new Date().toISOString();
    const order = {
      id: 'ORD-' + crypto.randomInt(100000, 1000000),
      customerName: cleanText(req.body?.customerName, 80) || 'Counter',
      phone: cleanText(req.body?.phone, 25) || '-',
      notes: cleanText(req.body?.notes, 300),
      items: priced.items,
      grossTotal: gross,
      discountAmount: discount,
      discountReason: cleanText(req.body?.discountReason, 120) || null,
      total,
      paymentMethod,
      // Counter sales are settled at the moment they are rung up.
      paymentStatus: 'paid',
      paidAt: now,
      status: 'pending',
      latitude: null, longitude: null, distance: null, zoneName: 'Counter',
      spamRisk: 'Safe', riskReason: 'Rung up at the counter',
      ipAddress: req.ip, sessionId: 'till-' + shift.id,
      source: 'till',
      orderType,
      shiftId: shift.id,
      staffName: cleanText(req.body?.staffName, 60) || shift.openedBy,
      cashReceived, cashChange,
      createdAt: now
    };

    await store.saveOrder(order);
    res.status(201).json({ success: true, order });
  } catch (err) { next(err); }
});

// ---- void ----
app.post('/api/admin/orders/:id/void', requireAdmin, async (req, res, next) => {
  try {
    const reason = cleanText(req.body?.reason, 200);
    if (!reason) return res.status(400).json({ error: 'A void needs a reason' });

    const existing = await store.getOrder(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    if (existing.voidedAt) return res.status(409).json({ error: 'That order is already voided' });

    const ok = await store.voidOrder(req.params.id, {
      reason, voidedBy: cleanText(req.body?.by, 60) || 'staff'
    });
    if (!ok) return res.status(409).json({ error: 'That order could not be voided' });

    res.json({ success: true, order: await store.getOrder(req.params.id) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Menu administration
// ---------------------------------------------------------------
// -------------------------------------------------------------
// Order pricing
//
// Shared by the customer app and the counter till: both must price a drink
// identically, and neither is allowed to send a price. An id is all the client
// supplies; everything else is looked up.
// -------------------------------------------------------------
class PriceError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.status = status || 400;
    Object.assign(this, extra || {});
  }
}

async function priceOrderItems(items) {
  const menu = await getMenu();
  let total = 0;
  const enrichedItems = [];

  for (const cartItem of items) {
    const original = menu.find(m => m.id === cartItem.id);
    if (!original) {
      throw new PriceError(`Invalid item reference: ID ${cartItem.id}`);
    }

    // Checked here as well as in the UI: a stale page could still submit an
    // item that sold out while the customer was choosing.
    if (!original.available) {
      throw new PriceError(
        `Sorry, ${original.name} just sold out. Please remove it and try again.`,
        409, { soldOutItemId: original.id }
      );
    }

    // Accepts a variant id; falls back to an index for older clients.
    let variant = null;
    if (cartItem.variantId != null) {
      variant = original.variants.find(v => v.id === Number(cartItem.variantId));
    } else if (typeof cartItem.variantIndex === 'number') {
      variant = original.variants[cartItem.variantIndex];
    }
    if (!variant) {
      throw new PriceError(`Invalid size or type selected for ${original.name}`);
    }

    // Quantity is the one number that scales the bill, so it is validated hard.
    const quantity = Number(cartItem.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new PriceError(`Invalid quantity for ${original.name} (1-20 per item)`);
    }

    // Resolve the chosen options against the groups this drink actually offers,
    // so a request cannot smuggle in an option from another drink.
    const requested = Array.isArray(cartItem.optionIds)
      ? cartItem.optionIds.map(Number).filter(Number.isInteger)
      : [];

    const allowed = new Map();
    for (const group of original.modifierGroups) {
      for (const option of group.options) allowed.set(option.id, { group, option });
    }

    const chosen = [];
    const perGroup = new Map();
    for (const optionId of requested) {
      const hit = allowed.get(optionId);
      if (!hit) throw new PriceError(`That option is not available for ${original.name}`);
      const count = (perGroup.get(hit.group.id) || 0) + 1;
      perGroup.set(hit.group.id, count);
      if (hit.group.selection === 'single' && count > 1) {
        throw new PriceError(`Only one ${hit.group.name} may be chosen for ${original.name}`);
      }
      chosen.push(hit);
    }

    // Required groups fall back to their default rather than rejecting the
    // order, so an older client that omits them still produces a valid ticket.
    for (const group of original.modifierGroups) {
      if (!group.required || perGroup.get(group.id)) continue;
      const fallback = group.options.find(o => o.isDefault) || group.options[0];
      if (fallback) chosen.push({ group, option: fallback });
    }

    const addonCharge = chosen.reduce((sum, c) => sum + c.option.priceDelta, 0);
    const finalPricePerUnit = Math.round((variant.price + addonCharge) * 100) / 100;
    total += finalPricePerUnit * quantity;

    const ordered = chosen.sort((a, b) => a.group.sortOrder - b.group.sortOrder);

    enrichedItems.push({
      id: original.id,
      name: original.name,
      variantId: variant.id,
      variantName: variant.name,
      basePrice: variant.price,
      price: finalPricePerUnit,
      quantity,
      category: original.category,
      company: original.company,
      modifiers: ordered.map(c => ({
        groupId: c.group.id,
        groupName: c.group.name,
        optionId: c.option.id,
        optionName: c.option.name,
        priceDelta: c.option.priceDelta
      })),
      modifiersText: ordered
        .map(c => modifierLabel(c.group.name, c.option.name, c.option.priceDelta))
        .join(' | ')
    });
  }

  return { items: enrichedItems, total: Math.round(total * 100) / 100 };
}

const PRICE_MAX = 999.99;

// Seasonal window. Blank clears the date rather than leaving it unchanged, so a
// drink can be made permanent again.
function readSeason(body) {
  const out = {};
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (body?.availableFrom !== undefined) {
    out.availableFrom = isDate(body.availableFrom) ? body.availableFrom : null;
  }
  if (body?.availableUntil !== undefined) {
    out.availableUntil = isDate(body.availableUntil) ? body.availableUntil : null;
  }
  return Object.keys(out).length ? out : null;
}

function readPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > PRICE_MAX) return null;
  return Math.round(n * 100) / 100;
}

// Everything staff need to edit, including hidden items.
app.get('/api/admin/menu', requireAdmin, async (req, res, next) => {
  try {
    const [menu, categories, modifiers] = await Promise.all([
      store.getMenu({ includeInactive: true }),
      store.listCategories(),
      store.listModifiers()
    ]);
    res.json({ menu, categories, modifiers });
  } catch (err) { next(err); }
});

app.post('/api/admin/menu/items', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 120);
    const description = cleanText(req.body?.description, 400);
    const imageUrl = cleanText(req.body?.imageUrl, 300);
    const categoryId = parseInt(req.body?.categoryId, 10);
    const variants = Array.isArray(req.body?.variants) ? req.body.variants : [];

    if (!name) return res.status(400).json({ error: 'A drink name is required' });
    if (!Number.isInteger(categoryId)) return res.status(400).json({ error: 'Choose a category' });
    if (!variants.length) return res.status(400).json({ error: 'Add at least one size or type' });

    const clean = [];
    for (const v of variants) {
      const vName = cleanText(v.name, 80);
      const price = readPrice(v.price);
      if (!vName) return res.status(400).json({ error: 'Every size needs a name' });
      if (price === null) return res.status(400).json({ error: `Invalid price for "${vName}"` });
      clean.push({ name: vName, price });
    }

    const id = await store.createItem({ categoryId, name, description, imageUrl, variants: clean });
    const season = readSeason(req.body);
    if (season) await store.updateItem(id, season);
    if (req.body?.imageId) await store.updateItem(id, { imageId: parseInt(req.body.imageId, 10) });
    invalidateMenuCache();
    res.status(201).json({ success: true, id });
  } catch (err) { next(err); }
});

app.patch('/api/admin/menu/items/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = {};
    if (req.body?.name !== undefined) fields.name = cleanText(req.body.name, 120);
    if (req.body?.description !== undefined) fields.description = cleanText(req.body.description, 400);
    if (req.body?.imageUrl !== undefined) fields.imageUrl = cleanText(req.body.imageUrl, 300) || null;
    if (req.body?.categoryId !== undefined) fields.categoryId = parseInt(req.body.categoryId, 10);
    if (req.body?.isActive !== undefined) fields.isActive = !!req.body.isActive;
    if (req.body?.imageId !== undefined) {
      fields.imageId = req.body.imageId === null ? null : parseInt(req.body.imageId, 10);
    }
    Object.assign(fields, readSeason(req.body) || {});

    if (fields.name === '') return res.status(400).json({ error: 'A drink name is required' });

    const ok = await store.updateItem(parseInt(req.params.id, 10), fields);
    if (!ok) return res.status(404).json({ error: 'Menu item not found' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/menu/items/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await store.deleteItem(parseInt(req.params.id, 10));
    invalidateMenuCache();
    res.json(Object.assign({ success: true }, result));
  } catch (err) { next(err); }
});

app.post('/api/admin/menu/items/:id/variants', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 80);
    const price = readPrice(req.body?.price);
    if (!name) return res.status(400).json({ error: 'A size name is required' });
    if (price === null) return res.status(400).json({ error: 'Invalid price' });
    const id = await store.addVariant(parseInt(req.params.id, 10), { name, price });
    invalidateMenuCache();
    res.status(201).json({ success: true, id });
  } catch (err) { next(err); }
});

app.patch('/api/admin/menu/variants/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = {};
    if (req.body?.name !== undefined) fields.name = cleanText(req.body.name, 80);
    if (req.body?.price !== undefined) {
      fields.price = readPrice(req.body.price);
      if (fields.price === null) return res.status(400).json({ error: 'Invalid price' });
    }
    if (req.body?.isActive !== undefined) fields.isActive = !!req.body.isActive;
    const ok = await store.updateVariant(parseInt(req.params.id, 10), fields);
    if (!ok) return res.status(404).json({ error: 'Size not found' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/menu/variants/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await store.deleteVariant(parseInt(req.params.id, 10));
    if (result.notFound) return res.status(404).json({ error: 'Size not found' });
    if (result.lastOne) return res.status(400).json({ error: 'A drink must keep at least one size' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ---- modifier groups and options ----
app.post('/api/admin/modifiers/groups', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 80);
    const selection = req.body?.selection === 'multi' ? 'multi' : 'single';
    if (!name) return res.status(400).json({ error: 'A group name is required' });
    const id = await store.createGroup({
      name, nameZh: cleanText(req.body?.nameZh, 40), selection, required: !!req.body?.required
    });
    invalidateMenuCache();
    res.status(201).json({ success: true, id });
  } catch (err) { next(err); }
});

app.patch('/api/admin/modifiers/groups/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = {};
    if (req.body?.name !== undefined) fields.name = cleanText(req.body.name, 80);
    if (req.body?.nameZh !== undefined) fields.nameZh = cleanText(req.body.nameZh, 40) || null;
    if (req.body?.selection !== undefined) fields.selection = req.body.selection === 'multi' ? 'multi' : 'single';
    if (req.body?.required !== undefined) fields.required = !!req.body.required;
    if (req.body?.isActive !== undefined) fields.isActive = !!req.body.isActive;
    const ok = await store.updateGroup(parseInt(req.params.id, 10), fields);
    if (!ok) return res.status(404).json({ error: 'Group not found' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/modifiers/groups/:id', requireAdmin, async (req, res, next) => {
  try {
    const ok = await store.deleteGroup(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Group not found' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/modifiers/groups/:id/options', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 80);
    const priceDelta = readPrice(req.body?.priceDelta ?? 0);
    if (!name) return res.status(400).json({ error: 'An option name is required' });
    if (priceDelta === null) return res.status(400).json({ error: 'Invalid price' });
    const id = await store.addOption(parseInt(req.params.id, 10), {
      name, nameZh: cleanText(req.body?.nameZh, 40), priceDelta, isDefault: !!req.body?.isDefault
    });
    invalidateMenuCache();
    res.status(201).json({ success: true, id });
  } catch (err) { next(err); }
});

app.patch('/api/admin/modifiers/options/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = {};
    if (req.body?.name !== undefined) fields.name = cleanText(req.body.name, 80);
    if (req.body?.nameZh !== undefined) fields.nameZh = cleanText(req.body.nameZh, 40) || null;
    if (req.body?.priceDelta !== undefined) {
      fields.priceDelta = readPrice(req.body.priceDelta);
      if (fields.priceDelta === null) return res.status(400).json({ error: 'Invalid price' });
    }
    if (req.body?.isDefault !== undefined) fields.isDefault = !!req.body.isDefault;
    if (req.body?.isActive !== undefined) fields.isActive = !!req.body.isActive;
    const ok = await store.updateOption(parseInt(req.params.id, 10), fields);
    if (!ok) return res.status(404).json({ error: 'Option not found' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/modifiers/options/:id', requireAdmin, async (req, res, next) => {
  try {
    const ok = await store.deleteOption(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Option not found' });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.put('/api/admin/modifiers/groups/:id/assignments', requireAdmin, async (req, res, next) => {
  try {
    const categoryIds = (req.body?.categoryIds || []).map(Number).filter(Number.isInteger);
    const itemIds = (req.body?.itemIds || []).map(Number).filter(Number.isInteger);
    await store.setGroupAssignments(parseInt(req.params.id, 10), { categoryIds, itemIds });
    invalidateMenuCache();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// 5. Admin update status
app.post('/api/admin/orders/:id/status', requireAdmin, async (req, res, next) => {
  try {
  const { status } = req.body || {};
  const existing = await store.getOrder(req.params.id);

  if (!existing) {
    return res.status(404).json({ error: "Order not found" });
  }

  const validStatuses = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  // Handing the drink over settles it. Cancelling leaves it unpaid, which the
  // session's unpaid count already ignores for cancelled orders.
  const paymentStatus = (status === 'completed' && existing.paymentStatus === 'pending')
    ? 'paid'
    : undefined;

  const order = await store.updateOrder(req.params.id, { status, paymentStatus });
  res.json({ success: true, order });
  } catch (err) { next(err); }
});

// 6. Admin mark order as paid (staff confirmed cash / transfer received)
app.post('/api/admin/orders/:id/pay', requireAdmin, async (req, res, next) => {
  try {
  const existing = await store.getOrder(req.params.id);

  if (!existing) {
    return res.status(404).json({ error: "Order not found" });
  }

  const order = await store.updateOrder(req.params.id, { paymentStatus: 'paid' });
  res.json({ success: true, order });
  } catch (err) { next(err); }
});

// 7. Payment gateway webhook (stub).
// Wire a real provider here: verify its signature, look the order up by the
// provider's reference, and only then set paymentStatus. Until that exists the
// endpoint stays disabled so nothing outside can mark an order paid.
app.post('/api/payments/webhook', (req, res) => {
  if (!PAYMENT_GATEWAY_ENABLED) {
    return res.status(501).json({ error: 'No payment gateway is configured.' });
  }
  return res.status(501).json({ error: 'Gateway webhook handler not implemented yet.' });
});

// -------------------------------------------------------------
// Error handling
//
// Database errors can carry connection details in their message, so the client
// only ever sees a generic failure. The real error goes to the server log.
// -------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// -------------------------------------------------------------
// Entry point
//
// On Vercel the platform imports this module and drives it as a serverless
// function, so it must not bind a port. Running it directly (npm start) still
// starts a normal long-lived server for local development.
// -------------------------------------------------------------
function describeBoot() {
  console.log(`Shop location anchored at: Lat ${RESTAURANT_LAT}, Lng ${RESTAURANT_LNG}`);
  console.log('Ordering zones:');
  ORDER_ZONES.forEach(z => {
    const counter = z.allowCounter ? 'counter allowed' : 'online only';
    console.log(`  - ${z.name}: ${z.radiusKm} km radius, ${counter}`);
  });
  if (ADMIN_PASSWORD_IS_GENERATED) {
    console.log('  ------------------------------------------------');
    console.log(`   ADMIN PASSWORD (generated): ${ADMIN_PASSWORD}`);
    console.log('   Set ADMIN_PASSWORD in the environment to fix it.');
    console.log('  ------------------------------------------------');
  }
  if (!PAYMENT_GATEWAY_ENABLED) {
    console.log('Payment gateway: DISABLED - all orders start unpaid and must be confirmed by staff.');
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`=== OTea x GreyOne server running on http://localhost:${PORT} ===`);
    describeBoot();
  });
} else {
  describeBoot();
}

module.exports = app;
