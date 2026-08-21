// Admin Application State
let orders = [];
let pollTimer = null;
let knownOrderIds = new Set();
let mapInstance = null;
let mapMarkers = {};
let restaurantLocation = { lat: 3.2158, lng: 101.7290 }; // replaced by /api/config on sign-in

// Staff session token, issued by POST /api/admin/login.
let adminToken = sessionStorage.getItem('luxe_admin_token');

// -------------------------------------------------------------
// Escaping: order fields are typed by customers, so nothing from an
// order may ever be dropped into innerHTML unescaped.
// -------------------------------------------------------------
// A crashed or misconfigured server answers with an HTML error page, not JSON.
// Parsing that blindly produced "Unexpected token 'A'" instead of telling the
// user what actually went wrong.
async function readJsonOrExplain(res) {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    if (res.status >= 500) {
      throw new Error('The server is not responding correctly (HTTP ' + res.status +
        '). Check /api/health for the cause.');
    }
    throw new Error('Unexpected response from the server (HTTP ' + res.status + ').');
  }
}

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
    const data = await readJsonOrExplain(res);
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
  loadShopLocation();
  startPolling();
  fetchAllOrders();
}

function signOut() {
  fetch('/api/admin/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  clearSession('Signed out.');
}

function clearSession(message) {
  adminToken = null;
  sessionStorage.removeItem('luxe_admin_token');
  stopPolling();
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

// -------------------------------------------------------------
// Polling
//
// Serverless functions cannot hold a WebSocket open, so the console refreshes
// the queue on a timer instead. New order ids are diffed against the previous
// poll so the counter still gets a chime when an order arrives.
// -------------------------------------------------------------
const POLL_INTERVAL_MS = 8000;

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollOrders, POLL_INTERVAL_MS);
  setConnectionLabel(true);

  // Pause while the tab is hidden; catch up immediately on return.
  document.addEventListener('visibilitychange', handleVisibility);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  document.removeEventListener('visibilitychange', handleVisibility);
  setConnectionLabel(false);
}

function handleVisibility() {
  if (document.hidden) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  } else if (adminToken && !pollTimer) {
    pollOrders();
    pollTimer = setInterval(pollOrders, POLL_INTERVAL_MS);
  }
}

function setConnectionLabel(live) {
  const label = document.getElementById('socketStatus');
  if (!label) return;
  label.innerText = live ? 'LIVE' : 'PAUSED';
  label.style.color = live ? 'var(--success)' : 'var(--danger)';
}

async function pollOrders() {
  if (!adminToken) return;
  try {
    const res = await adminFetch('/api/admin/orders');
    if (!res.ok) return;
    const fresh = await res.json();

    const arrived = fresh.filter(o => !knownOrderIds.has(o.id));
    fresh.forEach(o => knownOrderIds.add(o.id));

    orders = fresh;
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    renderOrdersQueue();
    updateMetrics();
    plotAllMarkers();
    setConnectionLabel(true);

    if (arrived.length) playNotificationSound();
  } catch (err) {
    setConnectionLabel(false);
  }
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
    orders.forEach(o => knownOrderIds.add(o.id));
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
            const modifierLine = item.modifiersText
              ? `<div style="font-size:0.75rem; color: var(--accent-color); margin-top:0.1rem;">${esc(item.modifiersText)}</div>`
              : '';
            return `
              <div class="admin-order-item-row" style="flex-direction:column; align-items:flex-start; border-bottom: 1px dashed rgba(255,255,255,0.04); padding-bottom: 0.4rem; margin-bottom: 0.2rem;">
                <div style="display:flex; justify-content:space-between; width:100%; font-weight:600;">
                  <span>${esc(item.name)} <strong style="color:var(--accent-color);">x${item.quantity}</strong></span>
                  <span>RM ${(item.price * item.quantity).toFixed(2)}</span>
                </div>
                <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.1rem;">
                  ${esc(item.variantName)}
                </div>
                ${modifierLine}
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
    const data = await readJsonOrExplain(res);
    
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
    const data = await readJsonOrExplain(res);

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
async function loadShopLocation() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.restaurant) {
      restaurantLocation = cfg.restaurant;
      if (mapInstance) mapInstance.setView([restaurantLocation.lat, restaurantLocation.lng], 13);
    }
  } catch (err) {
    console.warn('Could not load shop location', err);
  }
}

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

// -------------------------------------------------------------
// View switching
// -------------------------------------------------------------
function showView(name) {
  document.querySelectorAll('.admin-view').forEach(v => {
    v.style.display = v.id === `view-${name}` ? 'block' : 'none';
  });
  document.querySelectorAll('.admin-nav-item').forEach(a => {
    a.classList.toggle('active', a.dataset.view === name);
  });

  if (name === 'menu' || name === 'modifiers') loadMenuAdmin();
  if (name === 'till') loadTill();
  if (name === 'drawer') loadDrawer();
  if (name === 'history' && !historyState.loaded) loadHistory(0);
  // Leaflet mis-measures while its panel is hidden, so re-measure on return.
  if (name === 'dashboard' && mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 100);
  }
}

// -------------------------------------------------------------
// Menu editor
// -------------------------------------------------------------
let menuAdmin = { menu: [], categories: [], modifiers: [] };

async function loadMenuAdmin() {
  try {
    const res = await adminFetch('/api/admin/menu');
    if (!res.ok) throw new Error('Could not load the menu');
    menuAdmin = await readJsonOrExplain(res);
    renderMenuAdmin();
    renderModifierAdmin();
  } catch (err) {
    document.getElementById('menuAdminList').innerHTML =
      `<div style="text-align:center; color:var(--danger); padding:3rem;">${esc(err.message)}</div>`;
  }
}

function renderMenuAdmin() {
  const box = document.getElementById('menuAdminList');
  const byCategory = new Map();
  for (const item of menuAdmin.menu) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }

  box.innerHTML = [...byCategory.entries()].map(([category, items]) => {
    const company = items[0].company;
    return `
      <div class="stock-group">
        <div class="stock-group-title">
          ${esc(category)} <span style="opacity:0.6;">· ${esc(company)}</span>
        </div>
        ${items.map(item => `
          <div class="stock-row ${item.available === false ? 'is-out' : ''} ${item.isActive === false || item.expired ? 'is-hidden' : ''}">
            ${item.image ? `<img class="stock-thumb" src="${esc(item.image)}" alt="" loading="lazy">` : '<div class="stock-thumb placeholder">🥤</div>'}
            <div class="stock-name">
              ${esc(item.name)}
              <span class="stock-state">
                ${item.variants.map(v => esc(v.name) + ' RM' + v.price.toFixed(2)).join(' · ')}
              </span>
              <span class="stock-state">
                ${item.isActive === false ? '⚠️ Hidden · ' : ''}${item.expired ? '📅 Season ended · ' : ''}${item.available === false ? 'Sold out' : 'Available'}
                ${item.availableUntil && !item.expired ? ' · until ' + esc(item.availableUntil) : ''}
              </span>
            </div>
            <div class="stock-actions">
              <button class="btn btn-secondary stock-btn" onclick="openItemEditor(${item.id})">Edit</button>
              <button class="btn ${item.available === false ? 'btn-success' : 'btn-danger'} stock-btn"
                      onclick="toggleStock(${item.id}, ${item.available === false})">
                ${item.available === false ? 'In stock' : 'Sold out'}
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

async function toggleStock(id, makeAvailable) {
  try {
    const res = await adminFetch(`/api/admin/menu/${id}/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ available: makeAvailable })
    });
    if (!res.ok) throw new Error('Update failed');
    loadMenuAdmin();
  } catch (err) {
    alert(`Could not update stock: ${err.message}`);
  }
}

// -------------------------------------------------------------
// Shared editor dialog
// -------------------------------------------------------------
let dialogSubmit = null;

function openAdminDialog(title, bodyHtml, onSubmit) {
  document.getElementById('adminDialogTitle').innerText = title;
  document.getElementById('adminDialogBody').innerHTML = bodyHtml;
  document.getElementById('adminDialogError').style.display = 'none';
  document.getElementById('adminDialog').style.display = 'flex';
  dialogSubmit = onSubmit;
}

function closeAdminDialog() {
  document.getElementById('adminDialog').style.display = 'none';
  dialogSubmit = null;
}

function dialogError(message) {
  const box = document.getElementById('adminDialogError');
  box.innerText = message;
  box.style.display = 'block';
}

async function submitAdminDialog() {
  if (!dialogSubmit) return;
  const button = document.getElementById('adminDialogSave');
  button.disabled = true;
  try {
    await dialogSubmit();
    closeAdminDialog();
    loadMenuAdmin();
  } catch (err) {
    dialogError(err.message);
  } finally {
    button.disabled = false;
  }
}

function field(label, id, value, type) {
  return `<label class="dialog-field">
    <span>${esc(label)}</span>
    <input class="input-field" id="${id}" type="${type || 'text'}" value="${esc(value == null ? '' : value)}">
  </label>`;
}

// -------------------------------------------------------------
// Image upload
//
// Phone photos are several megabytes; the menu displays them barely 200px
// wide. Resizing on the device keeps uploads small and the database tidy.
// -------------------------------------------------------------
const IMAGE_MAX_EDGE = 700;

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        // WebP where supported, JPEG otherwise. Transparent PNGs lose their
        // background on JPEG, so those keep PNG.
        const wantsAlpha = file.type === 'image/png';
        const type = canvas.toDataURL('image/webp').startsWith('data:image/webp')
          ? 'image/webp'
          : (wantsAlpha ? 'image/png' : 'image/jpeg');

        const dataUrl = canvas.toDataURL(type, 0.85);
        resolve({
          mimeType: type,
          dataBase64: dataUrl.split(',')[1],
          width,
          height,
          previewUrl: dataUrl
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleImagePick(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  const status = document.getElementById('dlgImageStatus');
  status.innerText = 'Processing...';
  try {
    const resized = await resizeImageFile(file);
    const kb = Math.round(resized.dataBase64.length * 0.75 / 1024);

    const data = await adminJson('/api/admin/images', 'POST', {
      mimeType: resized.mimeType,
      dataBase64: resized.dataBase64,
      width: resized.width,
      height: resized.height
    });

    document.getElementById('dlgImageId').value = data.id;
    document.getElementById('dlgImagePreview').src = resized.previewUrl;
    document.getElementById('dlgImagePreview').style.display = 'block';
    status.innerText = `Uploaded · ${resized.width}x${resized.height} · ${kb}KB`;
  } catch (err) {
    status.innerText = err.message;
  }
}

function clearItemImage() {
  document.getElementById('dlgImageId').value = '';
  document.getElementById('dlgImagePreview').style.display = 'none';
  document.getElementById('dlgImageStatus').innerText = 'No picture';
}

// -------------------------------------------------------------
// Item editor
// -------------------------------------------------------------
function openItemEditor(itemId) {
  const item = itemId ? menuAdmin.menu.find(i => i.id === itemId) : null;

  const categoryOptions = menuAdmin.categories.map(c =>
    `<option value="${c.id}" ${item && item.categoryId === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.company)})</option>`
  ).join('');

  const variantRows = (item ? item.variants : [{ name: '', price: '' }]).map((v, i) => `
    <div class="variant-row" data-variant-id="${v.id || ''}">
      <input class="input-field" placeholder="Size or type" value="${esc(v.name || '')}" data-v-name>
      <input class="input-field" placeholder="0.00" type="number" step="0.10" min="0" value="${v.price === '' ? '' : v.price}" data-v-price>
      <button class="btn btn-danger stock-btn" onclick="this.closest('.variant-row').remove()">✕</button>
    </div>
  `).join('');

  openAdminDialog(item ? 'Edit drink' : 'New drink', `
    ${field('Name', 'dlgName', item ? item.name : '')}
    ${field('Description', 'dlgDesc', item ? item.description : '')}
    <label class="dialog-field">
      <span>Category</span>
      <select class="input-field" id="dlgCategory">${categoryOptions}</select>
    </label>
    <label class="dialog-field">
      <span>Picture</span>
      <div class="image-picker">
        <img id="dlgImagePreview" class="image-preview"
             src="${item && item.image ? esc(item.image) : ''}"
             style="display:${item && item.image ? 'block' : 'none'};" alt="">
        <div class="image-picker-controls">
          <input type="file" id="dlgImageFile" accept="image/*" onchange="handleImagePick(this)" style="display:none;">
          <button class="btn btn-secondary stock-btn" onclick="document.getElementById('dlgImageFile').click()">Choose picture</button>
          <button class="btn btn-secondary stock-btn" onclick="clearItemImage()">Remove</button>
          <span id="dlgImageStatus" class="image-status">${item && item.image ? 'Current picture' : 'No picture'}</span>
        </div>
      </div>
      <input type="hidden" id="dlgImageId" value="${item && item.imageId ? item.imageId : ''}">
    </label>

    <div class="season-row">
      ${field('Available from (optional)', 'dlgFrom', item ? (item.availableFrom || '') : '', 'date')}
      ${field('Available until (optional)', 'dlgUntil', item ? (item.availableUntil || '') : '', 'date')}
    </div>
    <p class="dialog-hint">Leave the dates blank for a permanent drink. A seasonal
       drink disappears from the customer menu by itself once the end date passes.</p>
    <label class="dialog-field" style="margin-top:0.5rem;">
      <span>Sizes and prices</span>
    </label>
    <div id="dlgVariants">${variantRows}</div>
    <button class="btn btn-secondary stock-btn" style="margin-top:0.4rem;" onclick="addVariantRow()">+ Add size</button>
    ${item ? `<label class="dialog-check"><input type="checkbox" id="dlgActive" ${item.isActive !== false ? 'checked' : ''}> Show on the customer menu</label>` : ''}
    ${item ? `<button class="btn btn-danger" style="width:100%; margin-top:0.9rem;" onclick="deleteItem(${item.id})">Delete this drink</button>` : ''}
  `, async () => {
    const variants = [...document.querySelectorAll('#dlgVariants .variant-row')].map(row => ({
      id: row.dataset.variantId || null,
      name: row.querySelector('[data-v-name]').value.trim(),
      price: row.querySelector('[data-v-price]').value
    })).filter(v => v.name);

    if (!variants.length) throw new Error('Add at least one size');

    const imageId = document.getElementById('dlgImageId').value;
    const payload = {
      name: document.getElementById('dlgName').value.trim(),
      description: document.getElementById('dlgDesc').value.trim(),
      categoryId: document.getElementById('dlgCategory').value,
      imageId: imageId ? Number(imageId) : null,
      availableFrom: document.getElementById('dlgFrom').value,
      availableUntil: document.getElementById('dlgUntil').value,
      variants
    };
    if (!payload.name) throw new Error('A drink name is required');

    if (!item) {
      await adminJson('/api/admin/menu/items', 'POST', payload);
      return;
    }

    const activeBox = document.getElementById('dlgActive');
    await adminJson(`/api/admin/menu/items/${item.id}`, 'PATCH', {
      name: payload.name, description: payload.description,
      categoryId: payload.categoryId, imageId: payload.imageId,
      availableFrom: payload.availableFrom, availableUntil: payload.availableUntil,
      isActive: activeBox ? activeBox.checked : true
    });

    // Variants are saved individually: existing ones patched, new ones added,
    // and any the user removed from the form deleted.
    const kept = new Set();
    for (const v of variants) {
      if (v.id) {
        kept.add(Number(v.id));
        await adminJson(`/api/admin/menu/variants/${v.id}`, 'PATCH', { name: v.name, price: v.price });
      } else {
        await adminJson(`/api/admin/menu/items/${item.id}/variants`, 'POST', { name: v.name, price: v.price });
      }
    }
    for (const original of item.variants) {
      if (!kept.has(original.id)) {
        await adminJson(`/api/admin/menu/variants/${original.id}`, 'DELETE');
      }
    }
  });
}

function addVariantRow() {
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.dataset.variantId = '';
  row.innerHTML = `
    <input class="input-field" placeholder="Size or type" data-v-name>
    <input class="input-field" placeholder="0.00" type="number" step="0.10" min="0" data-v-price>
    <button class="btn btn-danger stock-btn" onclick="this.closest('.variant-row').remove()">✕</button>`;
  document.getElementById('dlgVariants').appendChild(row);
}

async function deleteItem(id) {
  if (!confirm('Remove this drink from the menu?')) return;
  try {
    const res = await adminFetch(`/api/admin/menu/items/${id}`, { method: 'DELETE' });
    const data = await readJsonOrExplain(res);
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    if (data.archived) {
      alert('This drink has been sold before, so it was hidden rather than deleted. Past orders keep their history.');
    }
    closeAdminDialog();
    loadMenuAdmin();
  } catch (err) {
    dialogError(err.message);
  }
}

// -------------------------------------------------------------
// Modifier editor
// -------------------------------------------------------------
function renderModifierAdmin() {
  const box = document.getElementById('modifierAdminList');
  if (!box) return;

  const categoryName = id => (menuAdmin.categories.find(c => c.id === id) || {}).name || '?';
  const itemName = id => (menuAdmin.menu.find(i => i.id === id) || {}).name || '?';

  box.innerHTML = menuAdmin.modifiers.map(group => `
    <div class="stock-group">
      <div class="stock-group-title">
        ${esc(group.name)}${group.nameZh ? ' ' + esc(group.nameZh) : ''}
        <span style="opacity:0.6;">· ${group.selection === 'multi' ? 'choose any' : 'choose one'}${group.required ? ' · required' : ''}</span>
      </div>

      ${group.options.map(o => `
        <div class="stock-row">
          <div class="stock-name">
            ${esc(o.name)}${o.nameZh ? ' ' + esc(o.nameZh) : ''}
            <span class="stock-state">${o.priceDelta ? '+RM' + o.priceDelta.toFixed(2) : 'no charge'}${o.isDefault ? ' · default' : ''}</span>
          </div>
          <div class="stock-actions">
            <button class="btn btn-secondary stock-btn" onclick="openOptionEditor(${group.id}, ${o.id})">Edit</button>
            <button class="btn btn-danger stock-btn" onclick="deleteOption(${o.id})">✕</button>
          </div>
        </div>
      `).join('')}

      <div class="modifier-meta">
        Applies to:
        ${group.categoryIds.length ? group.categoryIds.map(id => esc(categoryName(id))).join(', ') : ''}
        ${group.itemIds.length ? (group.categoryIds.length ? ' · ' : '') + group.itemIds.map(id => esc(itemName(id))).join(', ') : ''}
        ${!group.categoryIds.length && !group.itemIds.length ? 'nothing yet' : ''}
      </div>

      <div class="stock-actions" style="margin-top:0.5rem;">
        <button class="btn btn-secondary stock-btn" onclick="openOptionEditor(${group.id})">+ Option</button>
        <button class="btn btn-secondary stock-btn" onclick="openAssignEditor(${group.id})">Where it applies</button>
        <button class="btn btn-secondary stock-btn" onclick="openGroupEditor(${group.id})">Edit group</button>
        <button class="btn btn-danger stock-btn" onclick="deleteGroup(${group.id})">Delete group</button>
      </div>
    </div>
  `).join('');
}

function openGroupEditor(groupId) {
  const group = groupId ? menuAdmin.modifiers.find(g => g.id === groupId) : null;
  openAdminDialog(group ? 'Edit group' : 'New modifier group', `
    ${field('Name', 'dlgGName', group ? group.name : '')}
    ${field('Chinese name (optional)', 'dlgGZh', group ? (group.nameZh || '') : '')}
    <label class="dialog-field">
      <span>Selection</span>
      <select class="input-field" id="dlgGSel">
        <option value="single" ${group && group.selection === 'single' ? 'selected' : ''}>Choose one (ice, sugar)</option>
        <option value="multi" ${group && group.selection === 'multi' ? 'selected' : ''}>Choose any (add-ons)</option>
      </select>
    </label>
    <label class="dialog-check"><input type="checkbox" id="dlgGReq" ${group && group.required ? 'checked' : ''}> Customer must choose one</label>
  `, async () => {
    const payload = {
      name: document.getElementById('dlgGName').value.trim(),
      nameZh: document.getElementById('dlgGZh').value.trim(),
      selection: document.getElementById('dlgGSel').value,
      required: document.getElementById('dlgGReq').checked
    };
    if (!payload.name) throw new Error('A group name is required');
    if (group) await adminJson(`/api/admin/modifiers/groups/${group.id}`, 'PATCH', payload);
    else await adminJson('/api/admin/modifiers/groups', 'POST', payload);
  });
}

function openOptionEditor(groupId, optionId) {
  const group = menuAdmin.modifiers.find(g => g.id === groupId);
  const option = optionId ? group.options.find(o => o.id === optionId) : null;
  openAdminDialog(option ? 'Edit option' : `New option in ${group.name}`, `
    ${field('Name', 'dlgOName', option ? option.name : '')}
    ${field('Chinese name (optional)', 'dlgOZh', option ? (option.nameZh || '') : '')}
    ${field('Extra charge (RM)', 'dlgOPrice', option ? option.priceDelta : '0', 'number')}
    <label class="dialog-check"><input type="checkbox" id="dlgODef" ${option && option.isDefault ? 'checked' : ''}> Selected by default</label>
  `, async () => {
    const payload = {
      name: document.getElementById('dlgOName').value.trim(),
      nameZh: document.getElementById('dlgOZh').value.trim(),
      priceDelta: document.getElementById('dlgOPrice').value || 0,
      isDefault: document.getElementById('dlgODef').checked
    };
    if (!payload.name) throw new Error('An option name is required');
    if (option) await adminJson(`/api/admin/modifiers/options/${option.id}`, 'PATCH', payload);
    else await adminJson(`/api/admin/modifiers/groups/${groupId}/options`, 'POST', payload);
  });
}

function openAssignEditor(groupId) {
  const group = menuAdmin.modifiers.find(g => g.id === groupId);
  const cats = menuAdmin.categories.map(c =>
    `<label class="dialog-check"><input type="checkbox" data-cat="${c.id}" ${group.categoryIds.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`
  ).join('');
  const items = menuAdmin.menu.map(i =>
    `<label class="dialog-check"><input type="checkbox" data-item="${i.id}" ${group.itemIds.includes(i.id) ? 'checked' : ''}> ${esc(i.name)}</label>`
  ).join('');

  openAdminDialog(`Where "${group.name}" applies`, `
    <p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.5rem;">
      Tick whole categories, or individual drinks for one-off choices.
    </p>
    <div class="assign-block"><strong>Categories</strong>${cats}</div>
    <div class="assign-block"><strong>Individual drinks</strong><div class="assign-scroll">${items}</div></div>
  `, async () => {
    const categoryIds = [...document.querySelectorAll('[data-cat]:checked')].map(e => Number(e.dataset.cat));
    const itemIds = [...document.querySelectorAll('[data-item]:checked')].map(e => Number(e.dataset.item));
    await adminJson(`/api/admin/modifiers/groups/${groupId}/assignments`, 'PUT', { categoryIds, itemIds });
  });
}

async function deleteGroup(id) {
  if (!confirm('Delete this whole group and its options?')) return;
  await adminJson(`/api/admin/modifiers/groups/${id}`, 'DELETE').catch(e => alert(e.message));
  loadMenuAdmin();
}

async function deleteOption(id) {
  if (!confirm('Delete this option?')) return;
  await adminJson(`/api/admin/modifiers/options/${id}`, 'DELETE').catch(e => alert(e.message));
  loadMenuAdmin();
}

// Small wrapper: sends JSON, throws the server's message on failure.
async function adminJson(url, method, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await adminFetch(url, options);
  const data = await readJsonOrExplain(res);
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// -------------------------------------------------------------
// Order history
// -------------------------------------------------------------
const historyState = { offset: 0, limit: 25, total: 0, loaded: false };

function historyFilters() {
  return {
    from: document.getElementById('histFrom').value,
    to: document.getElementById('histTo').value,
    status: document.getElementById('histStatus').value,
    q: document.getElementById('histQuery').value.trim()
  };
}

function historyQueryString(extra) {
  const f = Object.assign(historyFilters(), extra || {});
  const params = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => { if (v) params.set(k, v); });
  return params.toString();
}

async function loadHistory(offset) {
  historyState.offset = Math.max(offset, 0);
  const box = document.getElementById('historyResults');
  box.innerHTML = `<div style="text-align:center; color:var(--text-secondary); padding:3rem;">Searching...</div>`;

  try {
    const qs = historyQueryString({ limit: historyState.limit, offset: historyState.offset });
    const res = await adminFetch(`/api/admin/history?${qs}`);
    if (!res.ok) throw new Error('Search failed');
    const data = await readJsonOrExplain(res);

    historyState.total = data.total;
    historyState.loaded = true;
    renderHistory(data);
  } catch (err) {
    box.innerHTML = `<div style="text-align:center; color:var(--danger); padding:3rem;">${esc(err.message)}</div>`;
  }
}

function renderHistory(data) {
  const box = document.getElementById('historyResults');

  document.getElementById('histSummary').innerHTML = `
    <span><strong>${data.total}</strong> order${data.total === 1 ? '' : 's'}</span>
    <span>Paid revenue: <strong style="color:var(--accent-color);">RM ${data.revenue.toFixed(2)}</strong></span>
  `;

  if (!data.orders.length) {
    box.innerHTML = `<div style="text-align:center; color:var(--text-secondary); padding:3rem;">No orders match those filters.</div>`;
    document.getElementById('histPager').style.display = 'none';
    return;
  }

  box.innerHTML = `
    <div class="history-table-wrap">
      <table class="history-table">
        <thead>
          <tr>
            <th>Order</th><th>When</th><th>Customer</th><th>Items</th>
            <th>Total</th><th>Payment</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.orders.map(o => {
            const when = new Date(o.createdAt);
            const items = o.items.map(i => `${i.quantity}x ${esc(i.name)}`).join('<br>');
            return `
              <tr>
                <td><strong>${esc(o.id)}</strong><br><span class="hist-zone">${esc(o.zoneName || '-')}</span></td>
                <td>${when.toLocaleDateString()}<br><span class="hist-zone">${when.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></td>
                <td>${esc(o.customerName)}<br><span class="hist-zone">${esc(o.phone)}</span></td>
                <td class="hist-items">${items}</td>
                <td>RM ${o.total.toFixed(2)}</td>
                <td>${esc(o.paymentMethod)}<br><span class="hist-zone" style="color:${o.paymentStatus === 'paid' ? 'var(--success)' : 'var(--warning)'};">${esc(o.paymentStatus)}</span></td>
                <td><span class="hist-status hist-${esc(o.status)}">${esc(o.status)}</span></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  const pager = document.getElementById('histPager');
  pager.style.display = 'flex';
  const page = Math.floor(historyState.offset / historyState.limit) + 1;
  const pages = Math.max(Math.ceil(historyState.total / historyState.limit), 1);
  document.getElementById('histPageLabel').innerText = `Page ${page} of ${pages}`;
  document.getElementById('histPrev').disabled = historyState.offset === 0;
  document.getElementById('histNext').disabled = historyState.offset + historyState.limit >= historyState.total;
}

function historyPage(direction) {
  loadHistory(historyState.offset + direction * historyState.limit);
}

// The CSV endpoint needs the auth header, so it is fetched and handed to the
// browser as a blob rather than opened as a plain link.
async function downloadHistoryCsv() {
  try {
    const res = await adminFetch(`/api/admin/history.csv?${historyQueryString()}`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `otea-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Could not export: ${err.message}`);
  }
}

// -------------------------------------------------------------
// Counter till
//
// Staff tap a drink, choose its modifiers, and the bill builds up on the right.
// Prices shown here are only for the cashier's benefit: the server re-prices
// everything from ids when the sale is submitted.
// -------------------------------------------------------------
let tillMenu = [];
let tillCategory = 'All';
let tillBill = [];
let tillOrderType = 'takeaway';
let tillDiscount = { type: 'none', value: 0, reason: '' };

async function loadTill() {
  try {
    const res = await fetch('/api/menu');
    tillMenu = await res.json();
    renderTillCategories();
    renderTillGrid();
    renderBill();
  } catch (err) {
    document.getElementById('tillGrid').innerHTML =
      `<div style="color:var(--danger); padding:2rem;">Could not load the menu.</div>`;
  }
}

function renderTillCategories() {
  const cats = ['All', ...new Set(tillMenu.map(i => i.category))];
  document.getElementById('tillCategories').innerHTML = cats.map(c =>
    `<button class="type-pill ${c === tillCategory ? 'active' : ''}" onclick="setTillCategory('${esc(c)}')">${esc(c)}</button>`
  ).join('');
}

function setTillCategory(c) {
  tillCategory = c;
  renderTillCategories();
  renderTillGrid();
}

function setOrderType(type) {
  tillOrderType = type;
  document.querySelectorAll('#tillOrderType .type-pill').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type));
}

function renderTillGrid() {
  const items = tillMenu.filter(i =>
    (tillCategory === 'All' || i.category === tillCategory) && i.available !== false);

  document.getElementById('tillGrid').innerHTML = items.map(i => `
    <button class="till-item" onclick="pickTillItem(${i.id})">
      <span class="till-item-name">${esc(i.name)}</span>
      <span class="till-item-price">RM ${i.variants[0].price.toFixed(2)}${i.variants.length > 1 ? '+' : ''}</span>
    </button>
  `).join('') || `<div class="till-empty">Nothing available in this category.</div>`;
}

// Opens the same kind of modifier choice the customer sees, in the dialog.
function pickTillItem(itemId) {
  const item = tillMenu.find(i => i.id === itemId);
  if (!item) return;

  const variantPills = item.variants.map((v, idx) =>
    `<button class="type-pill ${idx === 0 ? 'active' : ''}" data-variant="${v.id}"
             onclick="tillPickVariant(this)">${esc(v.name)} · RM${v.price.toFixed(2)}</button>`
  ).join('');

  const groups = (item.modifierGroups || []).map(g => `
    <div class="till-group">
      <span class="modifier-label">${esc(g.name)}${g.nameZh ? ' ' + esc(g.nameZh) : ''}</span>
      <div class="till-options">
        ${g.options.map(o => {
          const active = g.selection === 'single' && (o.isDefault || (g.required && g.options[0].id === o.id));
          return `<button class="type-pill ${active ? 'active' : ''}"
                   data-group="${g.id}" data-selection="${g.selection}" data-option="${o.id}"
                   onclick="tillToggleOption(this)">${esc(o.name)}${o.priceDelta ? ' +' + o.priceDelta.toFixed(2) : ''}</button>`;
        }).join('')}
      </div>
    </div>
  `).join('');

  openAdminDialog(item.name, `
    <div class="till-group"><span class="modifier-label">Size</span>
      <div class="till-options" id="tillVariants">${variantPills}</div></div>
    ${groups}
    <label class="dialog-field" style="margin-top:0.6rem;">
      <span>Quantity</span>
      <input class="input-field" id="tillQty" type="number" min="1" max="20" value="1">
    </label>
  `, async () => {
    const variantEl = document.querySelector('#tillVariants .type-pill.active');
    const variantId = Number(variantEl.dataset.variant);
    const variant = item.variants.find(v => v.id === variantId);

    const chosen = [...document.querySelectorAll('[data-option].active')].map(el => ({
      id: Number(el.dataset.option),
      groupId: Number(el.dataset.group)
    }));

    const options = chosen.map(c => {
      const group = item.modifierGroups.find(g => g.id === c.groupId);
      const option = group.options.find(o => o.id === c.id);
      return { group, option };
    });

    const unitPrice = variant.price + options.reduce((s, o) => s + o.option.priceDelta, 0);
    const qty = Math.max(1, Math.min(20, parseInt(document.getElementById('tillQty').value, 10) || 1));

    tillBill.push({
      itemId: item.id,
      name: item.name,
      variantId,
      variantName: variant.name,
      optionIds: options.map(o => o.option.id),
      optionsText: options.map(o => modifierLabel(o.group.name, o.option.name, o.option.priceDelta)).join(' | '),
      unitPrice: Math.round(unitPrice * 100) / 100,
      quantity: qty
    });
    renderBill();
  });
}

function tillPickVariant(el) {
  el.parentElement.querySelectorAll('.type-pill').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

function tillToggleOption(el) {
  if (el.dataset.selection === 'single') {
    el.parentElement.querySelectorAll(`[data-group="${el.dataset.group}"]`)
      .forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  } else {
    el.classList.toggle('active');
  }
}

function modifierLabel(groupName, optionName, priceDelta) {
  if (priceDelta) return `${optionName} (+RM${priceDelta.toFixed(2)})`;
  return `${groupName}: ${optionName}`;
}

function billGross() {
  return Math.round(tillBill.reduce((s, l) => s + l.unitPrice * l.quantity, 0) * 100) / 100;
}

function billDiscount() {
  const gross = billGross();
  let d = 0;
  if (tillDiscount.type === 'percent') d = Math.round(gross * tillDiscount.value) / 100;
  if (tillDiscount.type === 'amount') d = tillDiscount.value;
  return Math.round(Math.min(d, gross) * 100) / 100;
}

function renderBill() {
  const box = document.getElementById('tillLines');
  if (!tillBill.length) {
    box.innerHTML = `<div class="till-empty">Tap a drink to start a bill.</div>`;
  } else {
    box.innerHTML = tillBill.map((l, i) => `
      <div class="till-line">
        <div class="till-line-main">
          <span class="till-line-name">${esc(l.name)}</span>
          <span class="till-line-opts">${esc(l.variantName)}${l.optionsText ? ' | ' + esc(l.optionsText) : ''}</span>
        </div>
        <div class="till-line-qty">
          <button class="qty-btn" onclick="changeBillQty(${i}, -1)">-</button>
          <span class="qty-val">${l.quantity}</span>
          <button class="qty-btn" onclick="changeBillQty(${i}, 1)">+</button>
        </div>
        <span class="till-line-price">RM ${(l.unitPrice * l.quantity).toFixed(2)}</span>
      </div>
    `).join('');
  }

  const gross = billGross();
  const discount = billDiscount();
  document.getElementById('tillSummary').innerHTML = `
    <div class="till-total-row"><span>Subtotal</span><span>RM ${gross.toFixed(2)}</span></div>
    ${discount ? `<div class="till-total-row discount"><span>Discount${tillDiscount.reason ? ' · ' + esc(tillDiscount.reason) : ''}</span><span>- RM ${discount.toFixed(2)}</span></div>` : ''}
    <div class="till-total-row grand"><span>Total</span><span>RM ${(gross - discount).toFixed(2)}</span></div>
  `;

  document.getElementById('tillPay').innerHTML = `
    <button class="btn btn-secondary" style="width:100%; margin-bottom:0.5rem;" onclick="openDiscountDialog()">
      ${discount ? 'Change discount' : 'Add discount'}
    </button>
    <div class="pay-buttons">
      <button class="btn btn-primary" onclick="openPayDialog('cash')" ${tillBill.length ? '' : 'disabled'}>💵 Cash</button>
      <button class="btn btn-primary" onclick="openPayDialog('duitnow')" ${tillBill.length ? '' : 'disabled'}>📱 DuitNow</button>
      <button class="btn btn-primary" onclick="openPayDialog('tng')" ${tillBill.length ? '' : 'disabled'}>🔵 TnG</button>
    </div>
  `;
}

function changeBillQty(index, delta) {
  const line = tillBill[index];
  if (!line) return;
  line.quantity += delta;
  if (line.quantity <= 0) tillBill.splice(index, 1);
  renderBill();
}

function clearBill() {
  tillBill = [];
  tillDiscount = { type: 'none', value: 0, reason: '' };
  renderBill();
}

function openDiscountDialog() {
  openAdminDialog('Discount', `
    <label class="dialog-field"><span>Type</span>
      <select class="input-field" id="dscType">
        <option value="none">No discount</option>
        <option value="percent" ${tillDiscount.type === 'percent' ? 'selected' : ''}>Percentage</option>
        <option value="amount" ${tillDiscount.type === 'amount' ? 'selected' : ''}>Fixed amount (RM)</option>
      </select>
    </label>
    ${field('Value', 'dscValue', tillDiscount.value || '', 'number')}
    ${field('Reason', 'dscReason', tillDiscount.reason || '')}
    <p class="dialog-hint">Discounts are recorded separately from the price, so your sales
       figures still show what the drinks were worth.</p>
  `, async () => {
    const type = document.getElementById('dscType').value;
    const value = Number(document.getElementById('dscValue').value) || 0;
    const reason = document.getElementById('dscReason').value.trim();
    if (type !== 'none' && value <= 0) throw new Error('Enter a discount value');
    if (type === 'percent' && value > 100) throw new Error('A percentage cannot exceed 100');
    if (type !== 'none' && !reason) throw new Error('A discount needs a reason');
    tillDiscount = { type, value, reason };
    renderBill();
  });
}

function openPayDialog(method) {
  const due = Math.round((billGross() - billDiscount()) * 100) / 100;
  const label = { cash: 'Cash', duitnow: 'DuitNow QR', tng: 'TnG eWallet' }[method];

  openAdminDialog(`${label} · RM ${due.toFixed(2)}`, `
    <div class="pay-due">Amount due <strong>RM ${due.toFixed(2)}</strong></div>
    ${method === 'cash' ? `
      ${field('Cash received (RM)', 'payCash', due.toFixed(2), 'number')}
      <div class="quick-cash">
        ${[due, 10, 20, 50, 100].filter((v, i, a) => v >= due && a.indexOf(v) === i)
          .map(v => `<button class="type-pill" onclick="document.getElementById('payCash').value='${v.toFixed(2)}'; showChange(${due})">RM ${v.toFixed(2)}</button>`).join('')}
      </div>
      <div class="pay-change" id="payChange"></div>
    ` : `<p class="dialog-hint">Confirm once the transfer shows in your app.</p>`}
    ${field('Customer name (optional)', 'payName', '')}
  `, async () => {
    const payload = {
      items: tillBill.map(l => ({
        id: l.itemId, variantId: l.variantId,
        optionIds: l.optionIds, quantity: l.quantity
      })),
      paymentMethod: method,
      orderType: tillOrderType,
      customerName: document.getElementById('payName').value.trim() || 'Counter'
    };
    if (tillDiscount.type !== 'none') {
      payload.discountType = tillDiscount.type;
      payload.discountValue = tillDiscount.value;
      payload.discountReason = tillDiscount.reason;
    }
    if (method === 'cash') {
      payload.cashReceived = Number(document.getElementById('payCash').value);
      if (!(payload.cashReceived >= due)) throw new Error('Cash received is less than the amount due');
    }

    const data = await adminJson('/api/admin/till/orders', 'POST', payload);
    clearBill();
    if (method === 'cash' && data.order.cashChange > 0) {
      alert(`Change due: RM ${data.order.cashChange.toFixed(2)}`);
    }
  });

  if (method === 'cash') {
    document.getElementById('payCash').addEventListener('input', () => showChange(due));
    showChange(due);
  }
}

function showChange(due) {
  const received = Number(document.getElementById('payCash').value) || 0;
  const box = document.getElementById('payChange');
  if (!box) return;
  const change = Math.round((received - due) * 100) / 100;
  box.innerHTML = received < due
    ? `<span style="color:var(--danger);">Short by RM ${(due - received).toFixed(2)}</span>`
    : `Change <strong>RM ${change.toFixed(2)}</strong>`;
}

// -------------------------------------------------------------
// Cash drawer
// -------------------------------------------------------------
async function loadDrawer() {
  const box = document.getElementById('drawerBody');
  try {
    const res = await adminFetch('/api/admin/shift');
    const data = await readJsonOrExplain(res);

    if (!data.shift) {
      box.innerHTML = `
        <div class="drawer-closed">
          <p>No drawer is open. Counter sales are blocked until one is.</p>
          ${field('Who is on the till', 'openBy', '')}
          ${field('Opening float (RM)', 'openFloat', '150', 'number')}
          <button class="btn btn-primary" style="width:100%; margin-top:0.6rem;" onclick="openDrawer()">Open drawer</button>
        </div>`;
      return;
    }

    const t = data.totals;
    const row = (label, value, cls) =>
      `<div class="till-total-row ${cls || ''}"><span>${label}</span><span>RM ${value.toFixed(2)}</span></div>`;

    box.innerHTML = `
      <div class="drawer-head">
        Opened by <strong>${esc(data.shift.openedBy)}</strong>
        at ${new Date(data.shift.openedAt).toLocaleString()}
      </div>
      ${row('Opening float', t.openingFloat)}
      ${row('Cash sales', t.cashSales)}
      ${row('Paid in', t.paidIn)}
      ${row('Paid out', -t.paidOut)}
      ${row('Expected in drawer', t.expectedCash, 'grand')}
      <div class="drawer-side">
        ${row('Card / e-wallet sales', t.nonCashSales)}
        ${row('Discounts given', t.discounts)}
        ${row(`Voided (${t.voidedCount})`, t.voidedValue)}
        <div class="till-total-row"><span>Bills</span><span>${t.billCount}</span></div>
      </div>

      <div class="drawer-actions">
        <button class="btn btn-secondary" onclick="openCashDialog('in')">Paid in</button>
        <button class="btn btn-secondary" onclick="openCashDialog('out')">Paid out</button>
        <button class="btn btn-danger" onclick="openCloseDialog(${t.expectedCash})">Close drawer</button>
      </div>

      ${data.movements.length ? `
        <div class="drawer-movements">
          <strong>Cash movements</strong>
          ${data.movements.map(m => `
            <div class="till-total-row">
              <span>${m.direction === 'in' ? '↑' : '↓'} ${esc(m.reason)}</span>
              <span>${m.direction === 'in' ? '+' : '-'} RM ${m.amount.toFixed(2)}</span>
            </div>`).join('')}
        </div>` : ''}
    `;
  } catch (err) {
    box.innerHTML = `<div style="color:var(--danger); padding:2rem;">${esc(err.message)}</div>`;
  }
}

async function openDrawer() {
  try {
    await adminJson('/api/admin/shift/open', 'POST', {
      openedBy: document.getElementById('openBy').value.trim() || 'staff',
      openingFloat: Number(document.getElementById('openFloat').value) || 0
    });
    loadDrawer();
  } catch (err) { alert(err.message); }
}

function openCashDialog(direction) {
  openAdminDialog(direction === 'in' ? 'Paid in' : 'Paid out', `
    ${field('Amount (RM)', 'cashAmt', '', 'number')}
    ${field('Reason', 'cashReason', '')}
  `, async () => {
    const amount = Number(document.getElementById('cashAmt').value);
    const reason = document.getElementById('cashReason').value.trim();
    if (!(amount > 0)) throw new Error('Enter an amount');
    if (!reason) throw new Error('A reason is required');
    await adminJson('/api/admin/shift/cash', 'POST', { direction, amount, reason });
    loadDrawer();
  });
}

function openCloseDialog(expected) {
  openAdminDialog('Close drawer', `
    <div class="pay-due">Expected in drawer <strong>RM ${expected.toFixed(2)}</strong></div>
    ${field('Counted cash (RM)', 'closeCount', '', 'number')}
    ${field('Notes (optional)', 'closeNotes', '')}
    <p class="dialog-hint">Count the drawer before entering the figure. Any difference is
       recorded as a variance rather than quietly adjusted.</p>
  `, async () => {
    const counted = Number(document.getElementById('closeCount').value);
    if (!Number.isFinite(counted)) throw new Error('Enter the counted cash');
    const data = await adminJson('/api/admin/shift/close', 'POST', {
      countedCash: counted,
      notes: document.getElementById('closeNotes').value.trim()
    });
    const v = data.variance;
    alert(v === 0 ? 'Drawer balanced exactly.'
      : `Variance: RM ${v.toFixed(2)} (${v < 0 ? 'short' : 'over'})`);
    loadDrawer();
  });
}
