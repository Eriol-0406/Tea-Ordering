const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Port configuration
const PORT = process.env.PORT || 3000;

// Geolocation of restaurant (Singapore / KL coordinates)
const RESTAURANT_LAT = 1.352083;
const RESTAURANT_LNG = 103.819836;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  // 5. Coffee Series (咖啡系列)
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

  // 6. Non-Coffee Series
  {
    id: 26,
    name: "Iced Chocolate (冰巧克力)",
    category: "Non-Coffee",
    description: "Rich dark cocoa blended with ice-cold premium milk. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ],
    image: "/images/iceblend.png"
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

  // 7. Matcha Series (抹茶系列)
  {
    id: 29,
    name: "Matcha Latte (抹茶拿铁)",
    category: "Matcha",
    description: "Premium stone-ground matcha whisked with fresh milk. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 11.00 }
    ],
    image: "/images/matcha_latte.jpg" // Maps to our generated image asset!
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

let orders = [];

// Memory-based tracking for IP order rate limiting and sessions
const ipOrderLimits = {};
const sessionUnpaidCounterOrders = {};

// Helper: Haversine distance in km
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

function cleanIpLimits(ip) {
  if (!ipOrderLimits[ip]) return;
  const now = Date.now();
  ipOrderLimits[ip] = ipOrderLimits[ip].filter(ts => now - ts < 15 * 60 * 1000);
}

function getSpamRisk(distance, ip, sessionId) {
  let riskLevel = 'Safe';
  let reason = 'Location verified within range';

  if (distance === null) {
    riskLevel = 'Medium Risk';
    reason = 'No geolocation coordinates provided';
  } else if (distance > 15) {
    riskLevel = 'High Risk';
    reason = `Extremely far location (${distance} km)`;
  } else if (distance > 5) {
    riskLevel = 'Medium Risk';
    reason = `Moderate distance (${distance} km)`;
  }

  if (ipOrderLimits[ip] && ipOrderLimits[ip].length >= 2) {
    riskLevel = 'High Risk';
    reason += ' + Multiple rapid orders from same IP';
  }

  if (sessionUnpaidCounterOrders[sessionId] && sessionUnpaidCounterOrders[sessionId] >= 1) {
    riskLevel = 'High Risk';
    reason += ' + History of unpaid counter orders';
  }

  return { riskLevel, reason };
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Get restaurant menu
app.get('/api/menu', (req, res) => {
  res.json(menuItems);
});

// 2. Place an order
app.post('/api/orders', (req, res) => {
  const { customerName, phone, items, paymentMethod, location, sessionId, notes } = req.body;
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!customerName || !phone || !items || !items.length || !paymentMethod || !sessionId) {
    return res.status(400).json({ error: "Missing required order details" });
  }

  // IP Rate Limit Check
  cleanIpLimits(ipAddress);
  if (!ipOrderLimits[ipAddress]) {
    ipOrderLimits[ipAddress] = [];
  }
  if (ipOrderLimits[ipAddress].length >= 4) {
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

    const variant = original.variants[varIdx];
    let itemPrice = variant.price;

    // Apply Coffee Add-ons calculations
    let addonCharge = 0;
    let selectedAddons = [];

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
    total += finalPricePerUnit * cartItem.quantity;

    enrichedItems.push({
      id: original.id,
      name: original.name,
      variantName: variant.name,
      price: finalPricePerUnit,
      quantity: cartItem.quantity,
      ice: cartItem.ice || "Normal Ice",
      sugar: cartItem.sugar || "Normal Sugar",
      teaBase: cartItem.teaBase || "",
      addonsText: selectedAddons.join(", ")
    });
  }

  // Geolocation / Distance validation
  let distance = null;
  let hasLocation = false;
  let lat = null;
  let lng = null;

  if (location && typeof location.lat === 'number' && typeof location.lng === 'number') {
    lat = location.lat;
    lng = location.lng;
    distance = calculateDistance(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng);
    hasLocation = true;
  }

  // Geofencing Spam Rules
  if (!hasLocation) {
    if (paymentMethod === 'counter') {
      return res.status(403).json({
        error: "Location verification is required to place a 'Pay at Counter' order. Please enable GPS location access or complete online payment now."
      });
    }
  } else {
    if (distance > 25.0) {
      return res.status(403).json({
        error: `Order blocked. You are currently ${distance} km away, which is outside our 25 km delivery/service radius.`
      });
    }
    if (distance > 10.0 && paymentMethod === 'counter') {
      return res.status(403).json({
        error: `You are ${distance} km away. Pay at Counter is restricted for customers beyond 10 km to prevent spam. Please complete online payment to proceed.`
      });
    }
  }

  // Session unpaid counter orders check
  if (paymentMethod === 'counter' && sessionUnpaidCounterOrders[sessionId] >= 2) {
    return res.status(403).json({
      error: "Pay at Counter option is disabled for this session due to multiple unpaid outstanding orders. Please proceed with Online Payment."
    });
  }

  // Evaluate final risk score
  const { riskLevel, reason } = getSpamRisk(distance, ipAddress, sessionId);

  // Success: Register IP order timestamp for rate-limiting
  ipOrderLimits[ipAddress].push(Date.now());

  // Increment session counter if pay at counter
  if (paymentMethod === 'counter') {
    sessionUnpaidCounterOrders[sessionId] = (sessionUnpaidCounterOrders[sessionId] || 0) + 1;
  }

  const newOrder = {
    id: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    customerName,
    phone,
    notes: notes || "",
    items: enrichedItems,
    total: parseFloat(total.toFixed(2)),
    paymentMethod,
    paymentStatus: paymentMethod === 'online' ? 'paid' : 'pending',
    status: 'pending',
    latitude: lat,
    longitude: lng,
    distance,
    spamRisk: riskLevel,
    riskReason: reason,
    ipAddress,
    sessionId,
    createdAt: new Date().toISOString()
  };

  orders.push(newOrder);

  // Notify admin dashboard instantly via WebSocket
  io.emit('new_order', newOrder);

  res.status(201).json({
    success: true,
    orderId: newOrder.id,
    order: newOrder
  });
});

// 3. Track customer order status
app.get('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json(order);
});

// 4. Admin fetch all orders
app.get('/api/admin/orders', (req, res) => {
  res.json(orders);
});

// 5. Admin update status
app.post('/api/admin/orders/:id/status', (req, res) => {
  const { status } = req.body;
  const order = orders.find(o => o.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const validStatuses = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  order.status = status;

  // Auto-pay counter orders on completion
  if (status === 'completed' && order.paymentMethod === 'counter') {
    order.paymentStatus = 'paid';
    if (sessionUnpaidCounterOrders[order.sessionId] > 0) {
      sessionUnpaidCounterOrders[order.sessionId]--;
    }
  }

  if (status === 'cancelled' && order.paymentMethod === 'counter') {
    if (sessionUnpaidCounterOrders[order.sessionId] > 0) {
      sessionUnpaidCounterOrders[order.sessionId]--;
    }
  }

  // Notify all sockets about order updates
  io.emit('order_status_update', {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus
  });

  res.json({ success: true, order });
});

// 6. Admin mark order as paid
app.post('/api/admin/orders/:id/pay', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  order.paymentStatus = 'paid';

  if (order.paymentMethod === 'counter' && sessionUnpaidCounterOrders[order.sessionId] > 0) {
    sessionUnpaidCounterOrders[order.sessionId]--;
  }

  // Broadcast update
  io.emit('order_status_update', {
    id: order.id,
    paymentStatus: 'paid'
  });

  res.json({ success: true, order });
});

// Socket.io event handling
io.on('connection', (socket) => {
  console.log(`Socket admin client connected: ${socket.id}`);

  socket.emit('restaurant_info', {
    lat: RESTAURANT_LAT,
    lng: RESTAURANT_LNG
  });

  socket.on('disconnect', () => {
    console.log(`Socket admin client disconnected: ${socket.id}`);
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`=== Tea/Coffee Order Server Running on http://localhost:${PORT} ===`);
  console.log(`Restaurant location anchored at: Lat ${RESTAURANT_LAT}, Lng ${RESTAURANT_LNG}`);
});
