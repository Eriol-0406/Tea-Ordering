const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

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

const io = socketIo(server, {
  cors: { origin: process.env.CORS_ORIGIN || false, methods: ["GET", "POST"] }
});

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
const menuItems = [
  // 1. Milk Tea (奶茶)
  {
    id: 1,
    name: "Jasmine Green Milk Tea (茉莉奶绿)",
    category: "Milk Tea",
    description: "Fragrant jasmine green tea blended with sweet milk, cold and refreshing.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 2,
    name: "White Peach Oolong Milk Tea (白桃乌龙)",
    category: "Milk Tea",
    description: "Premium white peach oolong tea infused with milky goodness.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 3,
    name: "Da Hong Pao Milk Tea (大红袍奶茶)",
    category: "Milk Tea",
    description: "Rich, roasted Da Hong Pao tea combined with milk for a deep flavor.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 4,
    name: "Camellia Milk Tea (山茶花奶茶)",
    category: "Milk Tea",
    description: "Floral camellia oolong tea mixed with smooth milk cream.",
    variants: [
      { name: "M (500ml)", price: 9.00 },
      { name: "L (700ml)", price: 11.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 5,
    name: "Lemon Jasmine Milk Tea (柠檬茉莉)",
    category: "Milk Tea",
    description: "Unique pairing of fresh tangy lemon with creamy jasmine milk tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 6,
    name: "Cocoa Milk Tea (可可奶茶)",
    category: "Milk Tea",
    description: "Luxurious chocolate powder brewed with premium milk tea.",
    variants: [
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 7,
    name: "Sea Salt Camellia Milk Tea (海盐奶茶)",
    category: "Milk Tea",
    description: "Floral camellia oolong milk tea topped with savory sea salt froth.",
    variants: [
      { name: "M (500ml)", price: 9.00 },
      { name: "L (700ml)", price: 11.00 }
    ],
    image: "/images/milktea.png"
  },

  // 2. Fruit Tea (水果茶)
  {
    id: 8,
    name: "Jasmine Perfume Lemon Tea (暴打柠檬茶)",
    category: "Fruit Tea",
    description: "Smashed fresh perfume lemon in high-grade jasmine green tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ]
  },
  {
    id: 9,
    name: "Lemon Tea (柠檬茶)",
    category: "Fruit Tea",
    description: "Tangy fresh lemon in your choice of roasted oolong or peach base tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ]
  },
  {
    id: 10,
    name: "Camellia Perfume Lemon Tea (山茶花柠檬茶)",
    category: "Fruit Tea",
    description: "Freshly muddled perfume lemons in elegant camellia oolong tea.",
    variants: [
      { name: "M (500ml)", price: 9.00 },
      { name: "L (700ml)", price: 11.00 }
    ]
  },
  {
    id: 11,
    name: "White Peach Oolong Grape Tea (青提乌龙)",
    category: "Fruit Tea",
    description: "Sweet green grapes blended with premium white peach oolong tea.",
    variants: [
      { name: "M (500ml)", price: 10.00 },
      { name: "L (700ml)", price: 12.00 }
    ]
  },
  {
    id: 12,
    name: "Crystal Grape Oolong Tea (青提脆波波)",
    category: "Fruit Tea",
    description: "Fragrant oolong tea loaded with fresh grapes and crunchy crystal boba.",
    variants: [
      { name: "M (500ml)", price: 12.00 },
      { name: "L (700ml)", price: 14.00 }
    ]
  },
  {
    id: 13,
    name: "Jasmine Perfume Grape Tea (青提柠檬)",
    category: "Fruit Tea",
    description: "Muddled grapes and perfume lemon shaken with jasmine green tea.",
    variants: [
      { name: "M (500ml)", price: 11.00 },
      { name: "L (700ml)", price: 13.00 }
    ]
  },
  {
    id: 14,
    name: "Jasmine Peach Tea (茉莉桃香)",
    category: "Fruit Tea",
    description: "Refreshing peach purée blended with icy jasmine green tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ]
  },

  // 3. Pure Tea (纯茶)
  {
    id: 15,
    name: "White Peach Tea (白桃)",
    category: "Pure Tea",
    description: "Clean and aromatic white peach oolong tea.",
    variants: [
      { name: "Pure Tea (纯茶)", price: 8.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 11.00 }
    ],
    image: "/images/puretea.png"
  },
  {
    id: 16,
    name: "Da Hong Pao Tea (大红袍)",
    category: "Pure Tea",
    description: "Dark, roasted rock oolong tea with a lingering sweet finish.",
    variants: [
      { name: "Pure Tea (纯茶)", price: 8.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 11.00 }
    ],
    image: "/images/puretea.png"
  },
  {
    id: 17,
    name: "Camellia Tea (山茶花)",
    category: "Pure Tea",
    description: "Floral camellia oolong tea, crisp and light-bodied.",
    variants: [
      { name: "Pure Tea (纯茶)", price: 9.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 12.00 }
    ],
    image: "/images/puretea.png"
  },

  // 4. Cold Brew Tea (冷萃茶)
  {
    id: 18,
    name: "Da Hong Pao Cold Brew (大红袍冷萃)",
    category: "Cold Brew",
    description: "Slow-dripped roasted oolong tea, highly refreshing with low bitterness.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ],
    image: "/images/dahongpaocoldbrew.png"
  },
  {
    id: 19,
    name: "Tie Guan Yin Cold Brew (铁观音冷萃)",
    category: "Cold Brew",
    description: "Slow-steeped floral Tie Guan Yin oolong, served chilled.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ]
  },
  {
    id: 20,
    name: "Glutinous Green Cold Brew (糯香冷萃)",
    category: "Cold Brew",
    description: "Green tea with natural glutinous rice leaf aroma, brewed cold.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ],
    image: "/images/glutinousgreencoldbrew.png"
  },

  // 5. Smoothie (冰沙)
  {
    id: 35,
    name: "Fresh Watermelon Jasmine Tea (西瓜冰沙)",
    category: "Smoothie",
    description: "Fresh watermelon blended with jasmine green tea into an icy smoothie.",
    variants: [
      { name: "L (700ml)", price: 12.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 15.00 }
    ],
    image: "/images/watermelonsmoothie.png"
  },

  // 6. Coffee Series (咖啡系列)
  {
    id: 21,
    name: "Americano (美式)",
    category: "Coffee",
    description: "Double espresso shot diluted with purified water. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 6.00 }
    ],
    image: "/images/americano.png"
  },
  {
    id: 22,
    name: "Orange Americano (香橙美式)",
    category: "Coffee",
    description: "Fresh sweet orange juice topped with a double espresso shot. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 7.00 }
    ],
    image: "/images/orangeamericano.png"
  },
  {
    id: 23,
    name: "Latte (拿铁)",
    category: "Coffee",
    description: "Smooth double espresso shot with steamed milk and thin foam layer. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 8.00 }
    ],
    image: "/images/latte.png"
  },
  {
    id: 24,
    name: "Spanish Latte (西班牙拿铁)",
    category: "Coffee",
    description: "Latte sweetened with rich condensed milk for a velvety finish. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ],
    image: "/images/spanishlatte.png"
  },
  {
    id: 25,
    name: "Mocha (摩卡)",
    category: "Coffee",
    description: "Double espresso shot blended with dark chocolate and steamed milk. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ]
  },

  // 7. Non-Coffee Series
  {
    id: 26,
    name: "Iced Chocolate (冰巧克力)",
    category: "Non-Coffee",
    description: "Rich dark cocoa blended with ice-cold premium milk. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ]
  },
  {
    id: 27,
    name: "Yuzu Sparkling (柚子气泡饮)",
    category: "Non-Coffee",
    description: "Sweet, tangy Korean Yuzu jam with ice and sparkling water. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 6.00 }
    ],
    image: "/images/yuzusparkling.png"
  },
  {
    id: 28,
    name: "Jasmin Yuzu Lemon Tea (茉莉柚子柠檬茶)",
    category: "Non-Coffee",
    description: "Jasmine green tea with perfume lemons and candied yuzu peels. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 11.00 }
    ]
  },
  {
    id: 34,
    name: "Taro Latte (香芋拿铁)",
    category: "Non-Coffee",
    description: "Creamy milk flavored with rich, sweet purple taro root, served chilled. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 10.00 }
    ],
    image: "/images/tarolatte.png"
  },

  // 8. Matcha Series (抹茶系列)
  {
    id: 29,
    name: "Matcha Latte (抹茶拿铁)",
    category: "Matcha",
    description: "Premium stone-ground matcha whisked with fresh milk. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 11.00 }
    ]
  },
  {
    id: 30,
    name: "Hojicha Latte (焙茶拿铁)",
    category: "Matcha",
    description: "Roasted oolong green tea tea powder whisked with fresh milk. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 11.00 }
    ],
    image: "/images/hoijichalatte.png"
  },
  {
    id: 31,
    name: "Strawberry Matcha Latte (草莓抹茶拿铁)",
    category: "Matcha",
    description: "Layered matcha latte with fresh strawberry purée at the bottom. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 13.00 }
    ]
  },
  {
    id: 32,
    name: "Strawberry Hojicha Latte (草莓焙茶拿铁)",
    category: "Matcha",
    description: "Layered roasted hojicha latte with fresh strawberry purée. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 13.00 }
    ]
  },
  {
    id: 33,
    name: "Silky Matcha (抹茶升级杯)",
    category: "Matcha",
    description: "Uji matcha with a extra rich cream blend for a silky body. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 12.00 }
    ]
  }
];

// Crystal Boba is offered across the OTea tea range only - the GreyOne
// coffee/matcha side has its own add-ons. Mirrored in public/js/app.js.
const BOBA_CATEGORIES = ['Milk Tea', 'Fruit Tea', 'Pure Tea', 'Smoothie'];

// -------------------------------------------------------------
// Order storage (SQLite - see db.js)
// -------------------------------------------------------------
const store = require('./db');

// Anything written by the previous JSON-file version is pulled in once, then
// that file is renamed to .imported so it is never re-read.
store.importLegacyJson(path.join(__dirname, 'data', 'orders.json'));
console.log(`Order database ready: ${store.file}`);

function shutdown(signal) {
  try { store.close(); } catch (err) { /* already closed */ }
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
  pruneAdminTokens();
  pruneLoginAttempts();
}, 10 * 60 * 1000).unref();

// -------------------------------------------------------------
// Admin authentication
// -------------------------------------------------------------
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const adminTokens = new Map(); // token -> expiry timestamp
const loginAttempts = new Map(); // ip -> [timestamps of failures]
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function pruneAdminTokens() {
  const now = Date.now();
  for (const [token, expiry] of adminTokens) {
    if (expiry <= now) adminTokens.delete(token);
  }
}

function pruneLoginAttempts() {
  const now = Date.now();
  for (const [ip, stamps] of loginAttempts) {
    const fresh = stamps.filter(ts => now - ts < LOGIN_WINDOW_MS);
    if (fresh.length) loginAttempts.set(ip, fresh);
    else loginAttempts.delete(ip);
  }
}

function isValidAdminToken(token) {
  if (!token) return false;
  const expiry = adminTokens.get(token);
  if (!expiry) return false;
  if (expiry <= Date.now()) {
    adminTokens.delete(token);
    return false;
  }
  return true;
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
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  res.json({ success: true, token, expiresIn: ADMIN_TOKEN_TTL_MS });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  adminTokens.delete(token);
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

function getSpamRisk(distance, ip, sessionId, zoneName) {
  let riskLevel = 'Safe';
  let reason = zoneName ? `Verified inside ${zoneName}` : 'Location verified within range';

  if (distance === null) {
    riskLevel = 'Medium Risk';
    reason = 'No geolocation coordinates provided';
  } else if (!zoneName) {
    riskLevel = 'High Risk';
    reason = `Outside every ordering zone (${distance} km from shop)`;
  }

  if (store.countRecentOrdersForIp(ip, RATE_WINDOW_MS) >= 2) {
    riskLevel = 'High Risk';
    reason += ' + Multiple rapid orders from same IP';
  }

  if (store.countUnpaidForSession(sessionId) >= 1) {
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

// 1. Get restaurant menu
app.get('/api/menu', (req, res) => {
  res.json(menuItems);
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
app.post('/api/orders', (req, res) => {
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
  if (store.countRecentOrdersForIp(ipAddress, RATE_WINDOW_MS) >= MAX_ORDERS_PER_WINDOW) {
    return res.status(429).json({
      error: "Too many orders placed. To prevent spam, ordering is locked for 15 minutes."
    });
  }

  // Calculate order items and total price securely
  let total = 0;
  const enrichedItems = [];

  for (const cartItem of items) {
    const original = menuItems.find(m => m.id === cartItem.id);
    if (!original) {
      return res.status(400).json({ error: `Invalid item reference: ID ${cartItem.id}` });
    }

    const varIdx = typeof cartItem.variantIndex === 'number' ? cartItem.variantIndex : 0;
    if (varIdx < 0 || varIdx >= original.variants.length) {
      return res.status(400).json({ error: `Invalid variant selection for item ${original.name}` });
    }

    // Quantity is the one number that scales the bill, so it is validated hard.
    const quantity = Number(cartItem.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return res.status(400).json({ error: `Invalid quantity for ${original.name} (1-20 per item)` });
    }

    const variant = original.variants[varIdx];
    let itemPrice = variant.price;

    let addonCharge = 0;
    let selectedAddons = [];

    // Crystal Boba add-on (tea range only)
    if (BOBA_CATEGORIES.includes(original.category) && cartItem.addons && cartItem.addons.crystalBoba) {
      addonCharge += 2.00;
      selectedAddons.push("Crystal Boba (+RM2.00)");
    }

    // Apply Coffee Add-ons calculations
    if (original.category === 'Coffee' && cartItem.addons && cartItem.addons.extraEspresso) {
      addonCharge += 2.50;
      selectedAddons.push("Extra Espresso Shot (+RM2.50)");
    }

    // Apply Matcha Upgrades calculations
    if (original.category === 'Matcha' && cartItem.addons && cartItem.addons.nikoNekoUpgrade) {
      const upgrade = cartItem.addons.nikoNekoUpgrade;
      if (upgrade === 'yuri') {
        addonCharge += 2.00;
        selectedAddons.push("Niko Neko Yuri (+RM2.00)");
      } else if (upgrade === 'ajisai') {
        addonCharge += 3.00;
        selectedAddons.push("Niko Neko Ajisai (+RM3.00)");
      }
    }

    const finalPricePerUnit = itemPrice + addonCharge;
    total += finalPricePerUnit * quantity;

    enrichedItems.push({
      id: original.id,
      name: original.name,
      variantName: variant.name,
      price: finalPricePerUnit,
      quantity,
      ice: cleanText(cartItem.ice, 40) || "Normal Ice",
      sugar: cleanText(cartItem.sugar, 40) || "Normal Sugar",
      teaBase: cleanText(cartItem.teaBase, 60),
      addonsText: selectedAddons.join(", ")
    });
  }

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
  if (!paymentGuaranteed && store.countUnpaidForSession(sessionId) >= 2) {
    return res.status(403).json({
      error: "Ordering is paused for this session due to multiple unpaid outstanding orders. Please settle them at the counter first."
    });
  }

  // Evaluate final risk score
  const zoneName = matchedZone ? matchedZone.name : null;
  const { riskLevel, reason } = getSpamRisk(distance, ipAddress, sessionId, zoneName);

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

  store.saveOrder(newOrder);

  // Staff-only channel: full record including phone, IP and coordinates.
  io.to('admin').emit('new_order', newOrder);

  res.status(201).json({
    success: true,
    orderId: newOrder.id,
    order: customerView(newOrder)
  });
});

// 3. Track customer order status
app.get('/api/orders/:id', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json(trackingView(order));
});

// 4. Admin fetch all orders
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
  res.json(store.listOrders(limit));
});

// 4b. Admin sales reporting, straight out of the order tables
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  res.json({
    salesByDay: store.salesByDay(30),
    topDrinks: store.topDrinks(20)
  });
});

// 5. Admin update status
app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const existing = store.getOrder(req.params.id);

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

  const order = store.updateOrder(req.params.id, { status, paymentStatus });
  broadcastOrderUpdate(order);
  res.json({ success: true, order });
});

// 6. Admin mark order as paid (staff confirmed cash / transfer received)
app.post('/api/admin/orders/:id/pay', requireAdmin, (req, res) => {
  const existing = store.getOrder(req.params.id);

  if (!existing) {
    return res.status(404).json({ error: "Order not found" });
  }

  const order = store.updateOrder(req.params.id, { paymentStatus: 'paid' });
  broadcastOrderUpdate(order);
  res.json({ success: true, order });
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

function broadcastOrderUpdate(order) {
  const payload = {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus
  };
  io.to('admin').emit('order_status_update', payload);
  // Only the customer tracking this specific order hears about it.
  io.to(`order:${order.id}`).emit('order_status_update', payload);
}

// -------------------------------------------------------------
// Socket.io: admins are authenticated and isolated in their own room
// -------------------------------------------------------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.adminToken;
  socket.data.isAdmin = isValidAdminToken(token);
  next();
});

io.on('connection', (socket) => {
  if (socket.data.isAdmin) {
    socket.join('admin');
    console.log(`Admin client connected: ${socket.id}`);
  }

  socket.emit('restaurant_info', {
    lat: RESTAURANT_LAT,
    lng: RESTAURANT_LNG
  });

  // A customer subscribes to just their own order's updates.
  socket.on('track_order', (orderId) => {
    if (typeof orderId !== 'string' || !/^ORD-\d{6}$/.test(orderId)) return;
    socket.rooms.forEach(room => {
      if (room.startsWith('order:')) socket.leave(room);
    });
    socket.join(`order:${orderId}`);
  });

  socket.on('disconnect', () => {
    if (socket.data.isAdmin) console.log(`Admin client disconnected: ${socket.id}`);
  });
});

// -------------------------------------------------------------
// Start the server
// -------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`=== Tea/Coffee Order Server Running on http://localhost:${PORT} ===`);
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
});
