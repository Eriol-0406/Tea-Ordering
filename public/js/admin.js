// Admin Application State
let orders = [];
let socket = null;
let mapInstance = null;
let mapMarkers = {};
let restaurantLocation = { lat: 3.2158, lng: 101.7290 }; // replaced by restaurant_info on connect

// Staff session token, issued by POST /api/admin/login.
let adminToken = sessionStorage.getItem('luxe_admin_token');

// -------------------------------------------------------------
// Escaping: order fields are typed by customers, so nothing from an
// order may ever be dropped into innerHTML unescaped.
// -------------------------------------------------------------
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -------------------------------------------------------------
// Admin Initialization
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('adminLoginForm').addEventListener('submit', handleLogin);

  if (adminToken) {
    startConsole();
  } else {
    showLoginGate();
  }
});

function showLoginGate(message) {
  document.getElementById('adminLoginGate').style.display = 'flex';
  document.getElementById('adminWorkspace').style.display = 'none';
  const errorBox = document.getElementById('adminLoginError');
  if (message) {
    errorBox.innerText = message;
    errorBox.style.display = 'block';
  } else {
    errorBox.style.display = 'none';
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const input = document.getElementById('adminPasswordInput');
  const button = document.getElementById('adminLoginBtn');
  button.disabled = true;
  button.innerText = 'Checking...';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign-in failed');

    adminToken = data.token;
    sessionStorage.setItem('luxe_admin_token', adminToken);
    input.value = '';
    startConsole();
  } catch (err) {
    showLoginGate(err.message);
  } finally {
    button.disabled = false;
    button.innerText = 'Sign In';
  }
}

function startConsole() {
  document.getElementById('adminLoginGate').style.display = 'none';
  document.getElementById('adminWorkspace').style.display = 'flex';

  if (!mapInstance) initMap();
  if (!socket) initSocket();
  fetchAllOrders();
}

function signOut() {
  fetch('/api/admin/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  clearSession('Signed out.');
}

function clearSession(message) {
  adminToken = null;
  sessionStorage.removeItem('luxe_admin_token');
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  showLoginGate(message);
}

function authHeaders(extra) {
  return Object.assign({ 'Authorization': `Bearer ${adminToken}` }, extra || {});
}

// Any 401 means the token expired or was revoked; drop straight back to the gate.
async function adminFetch(url, options) {
  const opts = options || {};
  opts.headers = authHeaders(opts.headers);
  const res = await fetch(url, opts);
  if (res.status === 401) {
    clearSession('Session expired. Please sign in again.');
    throw new Error('Session expired');
  }
  return res;
}

function initSocket() {
  // The handshake token is what puts this socket in the staff-only room.
  socket = io({ auth: { adminToken } });

  const statusLabel = document.getElementById('socketStatus');

  socket.on('connect', () => {
    statusLabel.innerText = "CONNECTED";
    statusLabel.style.color = "var(--success)";
  });

  socket.on('disconnect', () => {
    statusLabel.innerText = "OFFLINE";
    statusLabel.style.color = "var(--danger)";
  });

  socket.on('restaurant_info', (info) => {
    restaurantLocation = info;
    if (mapInstance) {
      mapInstance.setView([restaurantLocation.lat, restaurantLocation.lng], 13);
      L.marker([restaurantLocation.lat, restaurantLocation.lng], {
        icon: L.divIcon({
          html: `<div style="font-size: 2.2rem; filter: drop-shadow(0 0 6px var(--accent-color));">✨</div>`,
          className: 'custom-div-icon',
          iconSize: [35, 35],
          iconAnchor: [17, 17]
        })
      })
      .addTo(mapInstance)
      .bindPopup("<strong>OTea x GreyOne</strong>")
      .openPopup();
    }
  });

  // Listen for new orders
  socket.on('new_order', (newOrder) => {
    orders.unshift(newOrder);
    playNotificationSound();
    renderOrdersQueue();
    updateMetrics();
    plotOrderMarker(newOrder);
  });

  // Listen for order status updates
  socket.on('order_status_update', (data) => {
    const order = orders.find(o => o.id === data.id);
    if (order) {
      if (data.status) order.status = data.status;
      if (data.paymentStatus) order.paymentStatus = data.paymentStatus;
      renderOrdersQueue();
      updateMetrics();
      updateOrderMarkerPopup(order);
    }
  });
}

function playNotificationSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    osc.start();
    
    osc.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.15); // A5
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.45);
    osc.stop(audioCtx.currentTime + 0.5);
  } catch (err) {
    console.log("Audio notification blocked/unsupported: ", err);
  }
}

async function fetchAllOrders() {
  try {
    const res = await adminFetch('/api/admin/orders');
    orders = await res.json();
    
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    renderOrdersQueue();
    updateMetrics();
    plotAllMarkers();
  } catch (err) {
    console.error("Failed fetching orders: ", err);
  }
}

// -------------------------------------------------------------
// UI Render Queue (Prints variants, ice, sugar, and upgrades)
// -------------------------------------------------------------
function renderOrdersQueue() {
  const queueContainer = document.getElementById('adminOrdersQueue');
  const filter = document.getElementById('statusFilter').value;

  let filteredOrders = orders;
  if (filter === 'active') {
    filteredOrders = orders.filter(o => ['pending', 'preparing', 'ready'].includes(o.status));
  } else {
    filteredOrders = orders.filter(o => o.status === filter);
  }

  if (!filteredOrders.length) {
    queueContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); padding: 4rem;">
        No active tickets matching: "${esc(filter.toUpperCase())}"
      </div>
    `;
    return;
  }

  queueContainer.innerHTML = filteredOrders.map(order => {
    const time = new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let actionButtons = '';
    if (order.status === 'pending') {
      actionButtons = `
        <button class="btn btn-primary" onclick="changeStatus('${esc(order.id)}', 'preparing')">Accept & Brew</button>
        <button class="btn btn-danger" onclick="changeStatus('${esc(order.id)}', 'cancelled')">Cancel/Spam</button>
      `;
    } else if (order.status === 'preparing') {
      actionButtons = `
        <button class="btn btn-success" onclick="changeStatus('${esc(order.id)}', 'ready')">Mark Ready</button>
        <button class="btn btn-danger" onclick="changeStatus('${esc(order.id)}', 'cancelled')">Cancel</button>
      `;
    } else if (order.status === 'ready') {
      // Online orders are pending too until staff confirm the transfer landed.
      const payButton = (order.paymentStatus === 'pending')
        ? `<button class="btn btn-success" onclick="markAsPaid('${esc(order.id)}')">💵 Paid</button>`
        : '';
      actionButtons = `
        ${payButton}
        <button class="btn btn-primary" onclick="changeStatus('${esc(order.id)}', 'completed')">Collected</button>
      `;
    }

    const riskClass = order.spamRisk.toLowerCase().replace(/\s+/g, '-');
    const distanceText = order.distance !== null ? `${order.distance} km` : 'Blocked Location';
    const hasNote = order.notes ? `<div style="font-size:0.75rem; color: var(--text-muted); margin-top:0.25rem;">📝 Notes: ${esc(order.notes)}</div>` : '';

    return `
      <div class="admin-order-card" id="card-${esc(order.id)}">
        <div class="order-card-header">
          <div>
            <span class="order-card-id">${esc(order.id)}</span>
            <span style="font-size:0.8rem; color: var(--text-muted); margin-left: 0.5rem;">${time}</span>
          </div>
          <span class="spam-risk-badge ${esc(riskClass)}">${esc(order.spamRisk)}</span>
        </div>

        <div class="order-card-meta">
          <div class="meta-item">👤 <strong>${esc(order.customerName)}</strong></div>
          <div class="meta-item">📞 ${esc(order.phone)}</div>
          <div class="meta-item">📍 Proximity: ${esc(distanceText)}</div>
          <div class="meta-item">🏷️ Zone: ${esc(order.zoneName || 'Outside zones')}</div>
          <div class="meta-item">💻 IP: ${esc(order.ipAddress)}</div>
        </div>

        <!-- Customizable drink lists formatted for the kitchen -->
        <div class="order-card-items-list" style="display:flex; flex-direction:column; gap:0.5rem;">
          ${order.items.map(item => {
            const addonLabel = item.addonsText 
              ? `<div style="font-size:0.75rem; color: var(--accent-color); margin-top:0.1rem;">➕ Upgrades: ${esc(item.addonsText)}</div>` 
              : '';
            const baseLabel = item.teaBase ? ` [${item.teaBase}]` : '';
            return `
              <div class="admin-order-item-row" style="flex-direction:column; align-items:flex-start; border-bottom: 1px dashed rgba(255,255,255,0.04); padding-bottom: 0.4rem; margin-bottom: 0.2rem;">
                <div style="display:flex; justify-content:space-between; width:100%; font-weight:600;">
                  <span>${esc(item.name)} <strong style="color:var(--accent-color);">x${item.quantity}</strong></span>
                  <span>RM ${(item.price * item.quantity).toFixed(2)}</span>
                </div>
                <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.1rem;">
                  Options: ${esc(item.variantName)}${esc(baseLabel)} | ${esc(item.ice)} | ${esc(item.sugar)}
                </div>
                ${addonLabel}
              </div>
            `;
          }).join('')}
        </div>

        <div class="order-card-total-row">
          <div style="font-size: 0.8rem; color: var(--text-secondary);">
            Payment: <strong style="color:var(--accent-color);">${esc(order.paymentMethod.toUpperCase())}</strong> 
            (<span style="color:${order.paymentStatus === 'paid' ? 'var(--success)' : 'var(--warning)'};">${esc(order.paymentStatus.toUpperCase())}</span>)
          </div>
          <div style="font-size: 1.1rem; color: var(--accent-color);">RM ${order.total.toFixed(2)}</div>
        </div>

        ${hasNote}
        
        <div style="font-size:0.75rem; color: var(--danger); padding-top:0.25rem; border-top:1px dashed rgba(255,255,255,0.05);">
          🛡️ Proximity Audit: ${esc(order.riskReason)}
        </div>

        <div class="order-card-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }).join('');
}

function filterOrders() {
  renderOrdersQueue();
}

// -------------------------------------------------------------
// API Actions
// -------------------------------------------------------------
async function changeStatus(id, newStatus) {
  try {
    const res = await adminFetch(`/api/admin/orders/${id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: newStatus })
    });

    if (!res.ok) throw new Error("Failed updating status");
    const data = await res.json();
    
    const idx = orders.findIndex(o => o.id === id);
    if (idx !== -1) {
      orders[idx] = data.order;
      renderOrdersQueue();
      updateMetrics();
      updateOrderMarkerPopup(data.order);
    }
  } catch (err) {
    alert(`Failed status progression: ${err.message}`);
  }
}

async function markAsPaid(id) {
  try {
    const res = await adminFetch(`/api/admin/orders/${id}/pay`, {
      method: 'POST'
    });

    if (!res.ok) throw new Error("Failed marking payment");
    const data = await res.json();

    const idx = orders.findIndex(o => o.id === id);
    if (idx !== -1) {
      orders[idx] = data.order;
      renderOrdersQueue();
      updateMetrics();
      updateOrderMarkerPopup(data.order);
    }
  } catch (err) {
    alert(`Failed updating payment: ${err.message}`);
  }
}

// -------------------------------------------------------------
// Metrics updates
// -------------------------------------------------------------
function updateMetrics() {
  let grossSales = 0;
  let activeCount = 0;
  let spamAlertCount = 0;
  let totalDistance = 0;
  let distanceCount = 0;

  orders.forEach(order => {
    if (order.status === 'completed') {
      grossSales += order.total;
    }
    
    if (['pending', 'preparing', 'ready'].includes(order.status)) {
      activeCount++;
      if (order.spamRisk === 'High Risk') {
        spamAlertCount++;
      }
    }

    if (order.distance !== null) {
      totalDistance += order.distance;
      distanceCount++;
    }
  });

  document.getElementById('metricSales').innerText = `RM ${grossSales.toFixed(2)}`;
  document.getElementById('metricActive').innerText = activeCount;
  document.getElementById('metricSpam').innerText = spamAlertCount;
  document.getElementById('metricDistance').innerText = distanceCount > 0 
    ? `${(totalDistance / distanceCount).toFixed(1)} km` 
    : '0.0 km';

  const spamCard = document.getElementById('spamMetricCard');
  if (spamAlertCount > 0) {
    spamCard.style.animation = 'pulseDangerGlow 1.5s infinite';
    spamCard.style.borderColor = 'var(--danger)';
  } else {
    spamCard.style.animation = 'none';
    spamCard.style.borderColor = 'var(--panel-border)';
  }
}

// -------------------------------------------------------------
// Live GPS Radar Maps
// -------------------------------------------------------------
function initMap() {
  mapInstance = L.map('adminLiveMap').setView([restaurantLocation.lat, restaurantLocation.lng], 12);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(mapInstance);

  L.marker([restaurantLocation.lat, restaurantLocation.lng], {
    icon: L.divIcon({
      html: `<div style="font-size: 2.2rem; filter: drop-shadow(0 0 6px var(--accent-color));">✨</div>`,
      className: 'custom-div-icon',
      iconSize: [35, 35],
      iconAnchor: [17, 17]
    })
  })
  .addTo(mapInstance)
  .bindPopup("<strong>OTea x GreyOne</strong>")
  .openPopup();
}

function plotAllMarkers() {
  for (const id in mapMarkers) {
    mapInstance.removeLayer(mapMarkers[id].marker);
    if (mapMarkers[id].line) mapInstance.removeLayer(mapMarkers[id].line);
  }
  mapMarkers = {};

  const activeOrders = orders.filter(o => ['pending', 'preparing', 'ready'].includes(o.status));
  activeOrders.forEach(plotOrderMarker);
}

function plotOrderMarker(order) {
  if (!order.latitude || !order.longitude) return;

  let iconHtml = '📍';
  let color = 'var(--success)';
  
  if (order.spamRisk === 'Medium Risk') {
    iconHtml = '⚠️';
    color = 'var(--warning)';
  } else if (order.spamRisk === 'High Risk') {
    iconHtml = '🚨';
    color = 'var(--danger)';
  }

  const pulseClass = order.spamRisk === 'High Risk' ? 'animation: pulseScan 1.5s infinite;' : '';

  const pinIcon = L.divIcon({
    html: `<div style="font-size: 1.6rem; filter: drop-shadow(0 0 5px ${color}); ${pulseClass}">${iconHtml}</div>`,
    className: 'custom-div-icon',
    iconSize: [25, 25],
    iconAnchor: [12, 12]
  });

  const marker = L.marker([order.latitude, order.longitude], { icon: pinIcon })
    .addTo(mapInstance);

  const linePoints = [
    [restaurantLocation.lat, restaurantLocation.lng],
    [order.latitude, order.longitude]
  ];
  const line = L.polyline(linePoints, {
    color: color,
    weight: 1.5,
    dashArray: '5, 8',
    opacity: 0.6
  }).addTo(mapInstance);

  mapMarkers[order.id] = { marker, line };
  updateOrderMarkerPopup(order);
}

function updateOrderMarkerPopup(order) {
  if (!mapMarkers[order.id]) return;

  const content = `
    <div style="font-family: var(--font-body); color: #000; min-width: 150px;">
      <h4 style="margin:0 0 0.25rem 0;">${esc(order.id)}</h4>
      <p style="margin:0 0 0.5rem 0; font-size: 0.8rem;">
        Customer: <strong>${esc(order.customerName)}</strong><br>
        Zone: ${esc(order.zoneName || 'Outside zones')}<br>
        Distance: ${esc(order.distance)} km<br>
        Risk: <strong>${esc(order.spamRisk)}</strong><br>
        Status: <strong style="text-transform: uppercase;">${esc(order.status)}</strong>
      </p>
      <button style="width:100%; border:none; background:var(--accent-color); color:#000; font-weight:600; padding:0.25rem; border-radius:4px; cursor:pointer;" onclick="focusOrderCard('${esc(order.id)}')">
        Focus Card
      </button>
    </div>
  `;

  mapMarkers[order.id].marker.bindPopup(content);
}

function focusOrderCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.borderColor = 'var(--accent-color)';
    card.style.boxShadow = 'var(--accent-glow)';
    
    setTimeout(() => {
      card.style.borderColor = 'var(--panel-border)';
      card.style.boxShadow = 'none';
    }, 2500);
  }
}
