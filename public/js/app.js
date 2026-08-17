// Global Application State
let menuData = [];
let cart = [];
let userLocation = null;
let currentStep = 1;
let selectedPaymentMethod = null;
let activeOrder = null;
let mapInstance = null;
let socket = null;
let restaurantLocation = { lat: 1.352083, lng: 103.819836 }; // Anchored KL/Singapore

// Active modifier modal state
let activeItemForCustomization = null;
let selectedVariantIndex = 0;
let selectedIce = "Normal Ice";
let selectedSugar = "Normal Sugar";
let selectedTeaBase = null; // "Da Hong Pao (大红袍)" or "White Peach (白桃乌龙)"
let selectedAddons = {
  extraEspresso: false,
  nikoNekoUpgrade: "none"
};

// QR countdown state
let qrTimerInterval = null;

// Unique Session ID for session checks
let sessionId = localStorage.getItem('luxe_session_id');
if (!sessionId) {
  sessionId = 'sess-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
  localStorage.setItem('luxe_session_id', sessionId);
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initSocket();
  fetchMenu();
  loadCartFromStorage();
  checkActiveOrder();
});

function initSocket() {
  socket = io();

  socket.on('restaurant_info', (info) => {
    restaurantLocation = info;
  });

  socket.on('order_status_update', (data) => {
    if (activeOrder && activeOrder.id === data.id) {
      if (data.status) activeOrder.status = data.status;
      if (data.paymentStatus) activeOrder.paymentStatus = data.paymentStatus;
      updateTrackingUI();
    }
  });
}

async function fetchMenu() {
  try {
    const res = await fetch('/api/menu');
    menuData = await res.json();
    renderMenu(menuData);
  } catch (err) {
    console.error("Failed to load menu: ", err);
    document.getElementById('menuGrid').innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: var(--danger); padding: 3rem;">
        ⚠️ Failed to load menu database. Check server connection.
      </div>
    `;
  }
}

// Render Drink Cards with "+" customize button
function renderMenu(items) {
  const menuGrid = document.getElementById('menuGrid');
  if (!items.length) {
    menuGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 3rem;">
        No drinks match your selection.
      </div>
    `;
    return;
  }

  menuGrid.innerHTML = items.map(item => {
    // Show starting price or single price
    const startingPrice = item.variants[0].price.toFixed(2);
    const priceText = item.variants.length > 1 ? `from RM ${startingPrice}` : `RM ${startingPrice}`;
    
    // Choose appropriate fallback emoji icon
    let icon = "🥤";
    if (item.category === "Coffee") icon = "☕";
    else if (item.category === "Pure Tea") icon = "🍵";
    else if (item.category === "Fruit Tea") icon = "🍊";
    else if (item.category === "Cold Brew") icon = "🧊";

    // Image mapping logic
    const imageTag = item.image 
      ? `<img class="menu-image" src="${item.image}" alt="${item.name}">`
      : `<div class="drink-fallback-icon">${icon}</div>`;

    const tagTag = item.image 
      ? '' 
      : `<span class="menu-tag" style="position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.65); padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; color: var(--text-secondary);">${item.category}</span>`;

    return `
      <div class="menu-card glass-panel" data-category="${item.category}">
        <div class="menu-image-container">
          ${imageTag}
          ${tagTag}
        </div>
        <div class="menu-content">
          <h3 class="menu-title">${item.name}</h3>
          <div class="menu-price-row">
            <span class="menu-price">${priceText}</span>
            <button class="add-btn-round" onclick="openModifiersModal(${item.id})">+</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function filterCategory(category) {
  const tabs = document.querySelectorAll('.category-tab');
  tabs.forEach(tab => {
    if (tab.innerText.toLowerCase() === category.toLowerCase() || 
        (category === 'All' && tab.innerText.includes('All'))) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  if (category === 'All') {
    renderMenu(menuData);
  } else {
    const filtered = menuData.filter(item => item.category === category);
    renderMenu(filtered);
  }
}

function handleSearch() {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  const filtered = menuData.filter(item => 
    item.name.toLowerCase().includes(query) || 
    item.category.toLowerCase().includes(query)
  );
  renderMenu(filtered);
}

// -------------------------------------------------------------
// Slide-Up Customization Modal Logic
// -------------------------------------------------------------
function openModifiersModal(itemId) {
  const item = menuData.find(m => m.id === itemId);
  if (!item) return;

  activeItemForCustomization = item;
  selectedVariantIndex = 0;
  selectedIce = "Normal Ice";
  selectedSugar = "Normal Sugar";
  selectedAddons = {
    extraEspresso: false,
    nikoNekoUpgrade: "none"
  };

  // Populate basic text
  document.getElementById('modDrinkTitle').innerText = item.name;
  document.getElementById('modDrinkDesc').innerText = item.description;

  // Render sizes/variants
  const sizeContainer = document.getElementById('modSizeContainer');
  sizeContainer.innerHTML = item.variants.map((v, idx) => `
    <div class="modifier-pill ${idx === 0 ? 'active' : ''}" 
         data-variant-idx="${idx}" 
         onclick="selectVariant(${idx})">
      ${v.name}<br><span style="font-size:0.7rem; font-weight:700; color:var(--accent-color);">RM ${v.price.toFixed(2)}</span>
    </div>
  `).join('');

  // Handle specialty addons sections
  const coffeeSection = document.getElementById('modCoffeeAddonSection');
  const matchaSection = document.getElementById('modMatchaAddonSection');
  const teaBaseSection = document.getElementById('modTeaBaseSection');

  // Reset active classes on standard options
  resetModifierPillSelection('modIceSection', 'Normal Ice', 'ice');
  resetModifierPillSelection('modSugarSection', 'Normal Sugar', 'sugar');

  if (item.category === "Coffee") {
    coffeeSection.style.display = 'block';
    document.getElementById('addonExtraEspresso').classList.remove('active');
  } else {
    coffeeSection.style.display = 'none';
  }

  if (item.category === "Matcha") {
    matchaSection.style.display = 'block';
    resetModifierPillSelection('modMatchaAddonSection', 'none', 'matcha');
  } else {
    matchaSection.style.display = 'none';
  }

  // Handle Lemon Tea base selector
  if (item.id === 9) {
    teaBaseSection.style.display = 'block';
    selectedTeaBase = "Da Hong Pao (大红袍)";
    resetModifierPillSelection('modTeaBaseSection', 'Da Hong Pao (大红袍)', 'base');
  } else {
    teaBaseSection.style.display = 'none';
    selectedTeaBase = null;
  }

  updateModifiersPriceTally();

  // Show bottom sheet overlay
  document.getElementById('modifiersModalOverlay').classList.add('open');
}

function closeModifiersModal() {
  document.getElementById('modifiersModalOverlay').classList.remove('open');
  activeItemForCustomization = null;
}

function selectVariant(idx) {
  selectedVariantIndex = idx;
  
  // Update UI active indicator
  const pills = document.querySelectorAll('#modSizeContainer .modifier-pill');
  pills.forEach(p => {
    if (parseInt(p.getAttribute('data-variant-idx')) === idx) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  updateModifiersPriceTally();
}

function selectIce(el) {
  selectedIce = el.getAttribute('data-ice');
  
  const pills = el.parentElement.querySelectorAll('.modifier-pill');
  pills.forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

function selectSugar(el) {
  selectedSugar = el.getAttribute('data-sugar');
  
  const pills = el.parentElement.querySelectorAll('.modifier-pill');
  pills.forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

function selectTeaBase(el) {
  selectedTeaBase = el.getAttribute('data-base');
  
  const pills = el.parentElement.querySelectorAll('.modifier-pill');
  pills.forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

function toggleAddon(type) {
  if (type === 'extraEspresso') {
    selectedAddons.extraEspresso = !selectedAddons.extraEspresso;
    const row = document.getElementById('addonExtraEspresso');
    if (selectedAddons.extraEspresso) {
      row.classList.add('active');
    } else {
      row.classList.remove('active');
    }
  }
  updateModifiersPriceTally();
}

function selectMatchaUpgrade(el) {
  selectedAddons.nikoNekoUpgrade = el.getAttribute('data-matcha');
  
  const pills = el.parentElement.querySelectorAll('.modifier-pill');
  pills.forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  
  updateModifiersPriceTally();
}

function resetModifierPillSelection(sectionId, activeValue, attrName) {
  const container = document.getElementById(sectionId);
  const pills = container.querySelectorAll('.modifier-pill');
  pills.forEach(p => {
    if (p.getAttribute(`data-${attrName}`) === activeValue) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
}

// Compute dynamic price tally
function updateModifiersPriceTally() {
  if (!activeItemForCustomization) return;

  const basePrice = activeItemForCustomization.variants[selectedVariantIndex].price;
  let addonCharge = 0;

  if (activeItemForCustomization.category === 'Coffee' && selectedAddons.extraEspresso) {
    addonCharge += 2.50;
  }

  if (activeItemForCustomization.category === 'Matcha') {
    const upgrade = selectedAddons.nikoNekoUpgrade;
    if (upgrade === 'yuri') addonCharge += 2.00;
    else if (upgrade === 'ajisai') addonCharge += 3.00;
  }

  const finalPrice = basePrice + addonCharge;
  document.getElementById('addToCartConfirmBtn').innerText = `Add to Cart (RM ${finalPrice.toFixed(2)})`;
}

// -------------------------------------------------------------
// Cart Manager (Modified to Hash-Based line items)
// -------------------------------------------------------------
function confirmAddToCart() {
  if (!activeItemForCustomization) return;

  const item = activeItemForCustomization;
  const variant = item.variants[selectedVariantIndex];

  // Hash key representation (includes selectedTeaBase to distinguish options)
  const hashUid = `${item.id}-${selectedVariantIndex}-${selectedIce.replace(/\s+/g, '')}-${selectedSugar.replace(/\s+/g, '')}-${selectedAddons.extraEspresso}-${selectedAddons.nikoNekoUpgrade}-${selectedTeaBase || 'none'}`;

  // Check if identical item configuration exists
  const existing = cart.find(c => c.uid === hashUid);
  
  if (existing) {
    existing.quantity++;
  } else {
    cart.push({
      uid: hashUid,
      id: item.id,
      variantIndex: selectedVariantIndex,
      ice: selectedIce,
      sugar: selectedSugar,
      teaBase: selectedTeaBase,
      addons: { ...selectedAddons },
      quantity: 1
    });
  }

  saveCartToStorage();
  updateCartBadge();
  closeModifiersModal();
  
  // Float Badge animation
  const badge = document.getElementById('cartBadge');
  badge.classList.remove('bounce-anim');
  void badge.offsetWidth;
  badge.classList.add('bounce-anim');
}

function updateCartQty(uid, delta) {
  const cartItem = cart.find(c => c.uid === uid);
  if (!cartItem) return;

  cartItem.quantity += delta;
  if (cartItem.quantity <= 0) {
    cart = cart.filter(c => c.uid !== uid);
  }

  saveCartToStorage();
  updateCartBadge();
  renderCartDrawer();
}

function removeCartItem(uid) {
  cart = cart.filter(c => c.uid !== uid);
  saveCartToStorage();
  updateCartBadge();
  renderCartDrawer();
}

function updateCartBadge() {
  const totalQty = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.getElementById('cartBadge').innerText = totalQty;
  
  const bottomBadge = document.getElementById('bottomCartBadge');
  if (bottomBadge) {
    bottomBadge.innerText = totalQty;
    bottomBadge.style.display = totalQty > 0 ? 'inline-flex' : 'none';
  }
}

function saveCartToStorage() {
  localStorage.setItem('luxe_cart', JSON.stringify(cart));
}

function loadCartFromStorage() {
  const stored = localStorage.getItem('luxe_cart');
  if (stored) {
    cart = JSON.parse(stored);
    updateCartBadge();
  }
}

function toggleCart(isOpen) {
  if (isOpen) {
    switchTab('cart');
  } else {
    switchTab('menu');
  }
}

// Compute prices dynamically in Cart Drawer
function renderCartDrawer() {
  const itemsContainer = document.getElementById('cartItems');
  const totalDisplay = document.getElementById('cartTotal');
  const checkoutBtn = document.getElementById('checkoutBtn');

  if (!cart.length) {
    itemsContainer.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-icon">🍵</div>
        <p>No drinks in selection</p>
      </div>
    `;
    totalDisplay.innerText = "RM 0.00";
    checkoutBtn.disabled = true;
    return;
  }

  checkoutBtn.disabled = false;
  let total = 0;

  itemsContainer.innerHTML = cart.map(cartItem => {
    const item = menuData.find(m => m.id === cartItem.id);
    if (!item) return '';
    
    const variant = item.variants[cartItem.variantIndex];
    let unitPrice = variant.price;
    let addonsTextList = [];

    if (item.category === 'Coffee' && cartItem.addons.extraEspresso) {
      unitPrice += 2.50;
      addonsTextList.push("Extra Espresso Shot (+RM2.50)");
    }
    if (item.category === 'Matcha' && cartItem.addons.nikoNekoUpgrade !== 'none') {
      const upgrade = cartItem.addons.nikoNekoUpgrade;
      if (upgrade === 'yuri') {
        unitPrice += 2.00;
        addonsTextList.push("Niko Neko Yuri (+RM2.00)");
      } else if (upgrade === 'ajisai') {
        unitPrice += 3.00;
        addonsTextList.push("Niko Neko Ajisai (+RM3.00)");
      }
    }

    const itemTotal = unitPrice * cartItem.quantity;
    total += itemTotal;

    const teaBaseString = cartItem.teaBase ? ` [${cartItem.teaBase}]` : '';
    const addonsString = addonsTextList.length ? ` | ${addonsTextList.join(', ')}` : '';
    const optionsText = `${variant.name}${teaBaseString} | ${cartItem.ice} | ${cartItem.sugar}${addonsString}`;

    return `
      <div class="cart-item">
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-options">${optionsText}</div>
          <div class="cart-item-price">RM ${itemTotal.toFixed(2)} <span style="font-size:0.7rem; color:var(--text-muted); font-weight:400;">(RM ${unitPrice.toFixed(2)} ea)</span></div>
          <div class="cart-item-controls">
            <button class="qty-btn" onclick="updateCartQty('${cartItem.uid}', -1)">-</button>
            <span class="qty-val">${cartItem.quantity}</span>
            <button class="qty-btn" onclick="updateCartQty('${cartItem.uid}', 1)">+</button>
            <button class="cart-item-remove" onclick="removeCartItem('${cartItem.uid}')">Remove</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  totalDisplay.innerText = `RM ${total.toFixed(2)}`;
}

// -------------------------------------------------------------
// Checkout Modal & DuitNow QR Simulator
// -------------------------------------------------------------
function openCheckoutModal() {
  toggleCart(false);
  document.getElementById('checkoutModalOverlay').classList.add('open');
  currentStep = 1;
  showStepPanel(currentStep);
  runLocationCheck();
}

function closeCheckoutModal() {
  document.getElementById('checkoutModalOverlay').classList.remove('open');
  clearQrTimer();
}

function showStepPanel(step) {
  for (let i = 1; i <= 4; i++) {
    const panel = document.getElementById(`stepPanel-${i}`);
    const node = document.getElementById(`stepNode-${i}`);
    
    if (i === step) {
      panel.classList.add('active');
      node.classList.add('active');
      node.classList.remove('completed');
    } else {
      panel.classList.remove('active');
      if (i < step) {
        node.classList.add('completed');
        node.classList.remove('active');
      } else {
        node.classList.remove('completed', 'active');
      }
    }
  }

  const percent = ((step - 1) / 3) * 100;
  document.getElementById('stepLineProgress').style.width = `${percent}%`;
}

function nextStep(step) {
  if (step === 3 && !selectedPaymentMethod) {
    alert("Please select a payment method to continue.");
    return;
  }
  
  currentStep = step;
  showStepPanel(currentStep);

  if (step === 4) {
    setupPaymentStepSubPanels();
  }
}

function prevStep(step) {
  currentStep = step;
  showStepPanel(currentStep);
  clearQrTimer();
}

// Geolocation Proximity Checkers
function runLocationCheck() {
  const icon = document.getElementById('locationStatusIcon');
  const title = document.getElementById('locationStatusTitle');
  const text = document.getElementById('locationStatusText');
  const coordsDiv = document.getElementById('locationCoords');
  const nextBtn = document.getElementById('locationNextBtn');

  icon.className = 'location-icon-status scanning';
  icon.innerText = '📍';
  title.innerText = 'Locating device...';
  text.innerText = 'Acquiring GPS location tokens for security check.';
  coordsDiv.style.display = 'none';
  nextBtn.disabled = true;

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        handleLocationSuccess(position.coords.latitude, position.coords.longitude);
      },
      (err) => {
        console.warn("GPS failed: ", err);
        handleLocationDenied();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    handleLocationDenied();
  }
}

function handleMockGpsChange() {
  const mockVal = document.getElementById('mockGps').value;

  if (mockVal === 'actual') {
    runLocationCheck();
    return;
  }

  const icon = document.getElementById('locationStatusIcon');
  const title = document.getElementById('locationStatusTitle');
  const text = document.getElementById('locationStatusText');
  const coordsDiv = document.getElementById('locationCoords');
  const nextBtn = document.getElementById('locationNextBtn');
  nextBtn.disabled = false;

  if (mockVal === 'near') {
    userLocation = { lat: 1.357083, lng: 103.824836 }; // 0.79 km
    icon.className = 'location-icon-status success';
    icon.innerText = '✅';
    title.innerText = 'Proximity Verified';
    text.innerText = 'You are within 0.79 km from the shop. Pay at Counter is unlocked.';
    coordsDiv.style.display = 'block';
    document.getElementById('coordLat').innerText = userLocation.lat.toFixed(5);
    document.getElementById('coordLng').innerText = userLocation.lng.toFixed(5);
    enablePaymentCounter(true);
  } 
  else if (mockVal === 'medium') {
    userLocation = { lat: 1.422083, lng: 103.899836 }; // 11.8 km
    icon.className = 'location-icon-status success';
    icon.innerText = '⚠️';
    title.innerText = 'Proximity Token Warning';
    text.innerText = 'You are 11.8 km away. Pay at Counter is locked (max 10 km). Prepay online is required.';
    coordsDiv.style.display = 'block';
    document.getElementById('coordLat').innerText = userLocation.lat.toFixed(5);
    document.getElementById('coordLng').innerText = userLocation.lng.toFixed(5);
    enablePaymentCounter(false);
  }
  else if (mockVal === 'far') {
    userLocation = { lat: 1.752083, lng: 104.219836 }; // 62.8 km
    icon.className = 'location-icon-status denied';
    icon.innerText = '❌';
    title.innerText = 'Store Outside Bounds';
    text.innerText = 'You are 62.8 km away. Ordering is restricted beyond 25 km perimeter.';
    coordsDiv.style.display = 'block';
    document.getElementById('coordLat').innerText = userLocation.lat.toFixed(5);
    document.getElementById('coordLng').innerText = userLocation.lng.toFixed(5);
    nextBtn.disabled = true;
  }
  else if (mockVal === 'deny') {
    handleLocationDenied();
  }
}

function handleLocationSuccess(lat, lng) {
  userLocation = { lat, lng };
  const icon = document.getElementById('locationStatusIcon');
  const title = document.getElementById('locationStatusTitle');
  const text = document.getElementById('locationStatusText');
  const coordsDiv = document.getElementById('locationCoords');
  const nextBtn = document.getElementById('locationNextBtn');

  const d = calculateDistanceLocal(restaurantLocation.lat, restaurantLocation.lng, lat, lng);
  coordsDiv.style.display = 'block';
  document.getElementById('coordLat').innerText = lat.toFixed(5);
  document.getElementById('coordLng').innerText = lng.toFixed(5);
  nextBtn.disabled = false;

  if (d <= 10.0) {
    icon.className = 'location-icon-status success';
    icon.innerText = '✅';
    title.innerText = 'Proximity Verified';
    text.innerText = `You are ${d} km from the store. Pay at Counter is unlocked.`;
    enablePaymentCounter(true);
  } else if (d <= 25.0) {
    icon.className = 'location-icon-status success';
    icon.innerText = '⚠️';
    title.innerText = 'Proximity Warning';
    text.innerText = `You are ${d} km away. Pay at Counter is restricted beyond 10 km. Please prepay online.`;
    enablePaymentCounter(false);
  } else {
    icon.className = 'location-icon-status denied';
    icon.innerText = '❌';
    title.innerText = 'Outside Ordering Bounds';
    text.innerText = `You are ${d} km away, which exceeds our 25 km perimeter.`;
    nextBtn.disabled = true;
  }
}

function handleLocationDenied() {
  userLocation = null;
  const icon = document.getElementById('locationStatusIcon');
  const title = document.getElementById('locationStatusTitle');
  const text = document.getElementById('locationStatusText');
  const nextBtn = document.getElementById('locationNextBtn');
  const coordsDiv = document.getElementById('locationCoords');

  coordsDiv.style.display = 'none';
  icon.className = 'location-icon-status denied';
  icon.innerText = '🔒';
  title.innerText = 'GPS Restricted';
  text.innerText = 'GPS coordinates unavailable. For security, Pay at Counter is disabled. You must pre-pay online.';
  nextBtn.disabled = false;
  enablePaymentCounter(false);
}

function calculateDistanceLocal(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(2));
}

function enablePaymentCounter(isEnabled) {
  const counterCard = document.getElementById('paymentCardCounter');
  const alertBanner = document.getElementById('paymentLocationAlert');

  if (isEnabled) {
    counterCard.classList.remove('disabled');
    alertBanner.style.display = 'none';
  } else {
    counterCard.classList.add('disabled');
    alertBanner.style.display = 'block';
    if (selectedPaymentMethod === 'counter') {
      selectedPaymentMethod = null;
      counterCard.classList.remove('selected');
    }
  }
}

function selectPaymentMethod(method) {
  const counterCard = document.getElementById('paymentCardCounter');
  const onlineCard = document.getElementById('paymentCardOnline');

  if (method === 'counter' && counterCard.classList.contains('disabled')) {
    return;
  }

  selectedPaymentMethod = method;

  if (method === 'counter') {
    counterCard.classList.add('selected');
    onlineCard.classList.remove('selected');
  } else {
    onlineCard.classList.add('selected');
    counterCard.classList.remove('selected');
  }
}

function handleDetailsStepSubmit() {
  const name = document.getElementById('customerName').value.trim();
  const phone = document.getElementById('customerPhone').value.trim();

  if (!name || !phone) {
    alert("Please fill in your Name and Phone Number.");
    return;
  }

  nextStep(4);
}

// Compute checkout amount totals
function getCartTotalAmount() {
  let total = 0;
  cart.forEach(cartItem => {
    const item = menuData.find(m => m.id === cartItem.id);
    if (!item) return;
    const variant = item.variants[cartItem.variantIndex];
    let price = variant.price;
    if (item.category === 'Coffee' && cartItem.addons.extraEspresso) price += 2.50;
    if (item.category === 'Matcha' && cartItem.addons.nikoNekoUpgrade === 'yuri') price += 2.00;
    if (item.category === 'Matcha' && cartItem.addons.nikoNekoUpgrade === 'ajisai') price += 3.00;
    total += price * cartItem.quantity;
  });
  return total;
}

function setupPaymentStepSubPanels() {
  const onlineSub = document.getElementById('onlinePaymentSubPanel');
  const counterSub = document.getElementById('counterPaymentSubPanel');
  const totalAmount = getCartTotalAmount();

  if (selectedPaymentMethod === 'online') {
    onlineSub.style.display = 'block';
    counterSub.style.display = 'none';
    
    // Set QR details
    document.getElementById('qrAmountDisplay').innerText = `RM ${totalAmount.toFixed(2)}`;
    // Block standard submit button (forces QR simulator scan)
    document.getElementById('submitOrderBtn').style.display = 'none';
    startQrCountdown();
  } else {
    onlineSub.style.display = 'none';
    counterSub.style.display = 'block';
    document.getElementById('counterAmountDisplay').innerText = totalAmount.toFixed(2);
    document.getElementById('submitOrderBtn').style.display = 'inline-flex';
  }
}

// -------------------------------------------------------------
// DuitNow QR Simulation Controllers
// -------------------------------------------------------------
function startQrCountdown() {
  clearQrTimer();
  let timeRemaining = 120; // 2 minutes

  const display = document.getElementById('qrTimerDisplay');

  qrTimerInterval = setInterval(() => {
    const mins = Math.floor(timeRemaining / 60);
    const secs = timeRemaining % 60;
    
    display.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    timeRemaining--;
    if (timeRemaining < 0) {
      clearInterval(qrTimerInterval);
      display.innerText = "EXPIRED";
      alert("Payment scan timer expired. Please regenerate checkout.");
      closeCheckoutModal();
    }
  }, 1000);
}

function clearQrTimer() {
  if (qrTimerInterval) {
    clearInterval(qrTimerInterval);
    qrTimerInterval = null;
  }
}

function simulateQrPaymentSuccess() {
  clearQrTimer();
  
  // Show submit button temporarily and click it
  const submitBtn = document.getElementById('submitOrderBtn');
  submitBtn.style.display = 'inline-flex';
  
  // Pulse green overlay animation
  alert("Payment Successful! Finalizing order...");
  submitFinalOrder();
}

// -------------------------------------------------------------
// Order submissions
// -------------------------------------------------------------
async function submitFinalOrder() {
  document.getElementById('paymentControlsRow').style.display = 'none';
  document.getElementById('onlinePaymentSubPanel').style.display = 'none';
  document.getElementById('counterPaymentSubPanel').style.display = 'none';
  document.getElementById('orderSubmitStatus').style.display = 'block';

  const name = document.getElementById('customerName').value.trim();
  const phone = document.getElementById('customerPhone').value.trim();
  const notes = document.getElementById('customerNotes').value.trim();

  // Parse items with full modifiers payloads
  const itemsPayload = cart.map(c => ({
    id: c.id,
    variantIndex: c.variantIndex,
    ice: c.ice,
    sugar: c.sugar,
    teaBase: c.teaBase,
    addons: { ...c.addons },
    quantity: c.quantity
  }));

  const payload = {
    customerName: name,
    phone: phone,
    notes: notes,
    items: itemsPayload,
    paymentMethod: selectedPaymentMethod,
    sessionId: sessionId,
    location: userLocation
  };

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to place order.");
    }

    activeOrder = data.order;
    sessionStorage.setItem('luxe_active_order', JSON.stringify(activeOrder));
    
    // Clear
    cart = [];
    saveCartToStorage();
    updateCartBadge();
    closeCheckoutModal();
    resetCheckoutForm();
    
    showTrackingView();

  } catch (err) {
    alert(`Checkout Error: ${err.message}`);
    // Unlock
    document.getElementById('paymentControlsRow').style.display = 'flex';
    setupPaymentStepSubPanels();
    document.getElementById('orderSubmitStatus').style.display = 'none';
  }
}

function resetCheckoutForm() {
  document.getElementById('customerName').value = '';
  document.getElementById('customerPhone').value = '';
  document.getElementById('customerNotes').value = '';
  document.getElementById('paymentCardCounter').classList.remove('selected');
  document.getElementById('paymentCardOnline').classList.remove('selected');
  selectedPaymentMethod = null;
  document.getElementById('paymentControlsRow').style.display = 'flex';
  document.getElementById('orderSubmitStatus').style.display = 'none';
  document.getElementById('mockGps').value = 'actual';
  clearQrTimer();
}

// -------------------------------------------------------------
// Real-time Order Tracking Views
// -------------------------------------------------------------
function checkActiveOrder() {
  const stored = sessionStorage.getItem('luxe_active_order');
  if (stored) {
    activeOrder = JSON.parse(stored);
    showTrackingView();
    setInterval(pollOrderStatus, 5000);
  }
}

async function pollOrderStatus() {
  if (!activeOrder) return;
  try {
    const res = await fetch(`/api/orders/${activeOrder.id}`);
    if (res.ok) {
      activeOrder = await res.json();
      updateTrackingUI();
    }
  } catch (err) {}
}

function showTrackingView() {
  switchTab('status');
}

function updateTrackingUI() {
  if (!activeOrder) return;

  document.getElementById('trackOrderId').innerText = activeOrder.id;
  
  const statuses = ['pending', 'preparing', 'ready', 'completed'];
  const currentIndex = statuses.indexOf(activeOrder.status);

  const heading = document.getElementById('trackStatusHeading');
  const desc = document.getElementById('trackStatusDesc');

  if (activeOrder.status === 'pending') {
    heading.innerText = "Queue Position Locked";
    desc.innerText = "Baristas are reviewing your customization tokens and location tag.";
  } else if (activeOrder.status === 'preparing') {
    heading.innerText = "Brewing Beverage";
    desc.innerText = "Our baristas are hand-crafting your custom drink layout.";
  } else if (activeOrder.status === 'ready') {
    heading.innerText = "Ready at Pick-up Counter";
    desc.innerText = "Your fresh drink is waiting at the counter. Grab it now!";
  } else if (activeOrder.status === 'completed') {
    heading.innerText = "Collected";
    desc.innerText = "Enjoy your fresh Luxe drink! See you again soon.";
  } else if (activeOrder.status === 'cancelled') {
    heading.innerText = "Queue Ticket Cancelled";
    desc.innerText = "This ticket was cancelled or flagged as spam/unresponsive.";
  }

  const progressLine = document.getElementById('timelineProgressBar');
  if (currentIndex === -1) {
    progressLine.style.width = '0%';
  } else {
    const percent = (currentIndex / 3) * 100;
    progressLine.style.width = `${percent}%`;
  }

  statuses.forEach((statusName, idx) => {
    const node = document.getElementById(`node-${statusName}`);
    node.className = 'timeline-node';

    if (activeOrder.status === 'cancelled') {
      node.classList.remove('completed', 'active');
    } else if (statusName === activeOrder.status) {
      node.classList.add('active');
    } else if (idx < currentIndex) {
      node.classList.add('completed');
    }
  });

  const itemsContainer = document.getElementById('trackReceiptItems');
  itemsContainer.innerHTML = activeOrder.items.map(item => {
    const addonLabel = item.addonsText ? `<br><span style="font-size:0.75rem; color:var(--text-muted);">➕ ${item.addonsText}</span>` : '';
    const baseLabel = item.teaBase ? ` [${item.teaBase}]` : '';
    return `
      <div class="receipt-row" style="flex-direction:column; align-items:flex-start; gap:0.15rem;">
        <div style="display:flex; justify-content:space-between; width:100%; font-weight:500;">
          <span>${item.name} <strong style="color:var(--text-muted);">x${item.quantity}</strong></span>
          <span>RM ${(item.price * item.quantity).toFixed(2)}</span>
        </div>
        <span style="font-size:0.75rem; color:var(--text-secondary);">Modifiers: ${item.variantName}${baseLabel} | ${item.ice} | ${item.sugar}</span>
        ${addonLabel}
      </div>
    `;
  }).join('');

  document.getElementById('trackReceiptPayment').innerText = 
    activeOrder.paymentMethod === 'online' ? 'Paid Securely Online (QR)' : 'Pay at Counter';
  
  const payStatusLabel = document.getElementById('trackReceiptPaymentStatus');
  payStatusLabel.innerText = activeOrder.paymentStatus.toUpperCase();
  if (activeOrder.paymentStatus === 'paid') {
    payStatusLabel.style.color = 'var(--success)';
  } else {
    payStatusLabel.style.color = 'var(--warning)';
  }

  document.getElementById('trackReceiptTotal').innerText = `RM ${activeOrder.total.toFixed(2)}`;

  if (activeOrder.status === 'completed' || activeOrder.status === 'cancelled') {
    sessionStorage.removeItem('luxe_active_order');
  }
}

function initTrackingMap() {
  if (!activeOrder) return;

  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  mapInstance = L.map('customerMap').setView([restaurantLocation.lat, restaurantLocation.lng], 13);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(mapInstance);

  L.marker([restaurantLocation.lat, restaurantLocation.lng], {
    icon: L.divIcon({
      html: `<div style="font-size: 2rem; filter: drop-shadow(0 0 5px var(--accent-color));">✨</div>`,
      className: 'custom-div-icon',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    })
  })
  .addTo(mapInstance)
  .bindPopup("<strong>Luxe Bar Kitchen</strong>")
  .openPopup();

  if (activeOrder.latitude && activeOrder.longitude) {
    const customerIcon = L.divIcon({
      html: `<div style="font-size: 1.5rem; filter: drop-shadow(0 0 6px var(--success)); animation: pulseScan 2s infinite;">📍</div>`,
      className: 'custom-div-icon',
      iconSize: [25, 25],
      iconAnchor: [12, 12]
    });

    L.marker([activeOrder.latitude, activeOrder.longitude], { icon: customerIcon })
      .addTo(mapInstance)
      .bindPopup(`<strong>Your Coordinate</strong><br>Distance: ${activeOrder.distance} km`);

    const pathPoints = [
      [restaurantLocation.lat, restaurantLocation.lng],
      [activeOrder.latitude, activeOrder.longitude]
    ];
    
    L.polyline(pathPoints, {
      color: '#f59e0b',
      weight: 1.8,
      dashArray: '5, 8',
      opacity: 0.7
    }).addTo(mapInstance);

    const bounds = L.latLngBounds(pathPoints);
    mapInstance.fitBounds(bounds, { padding: [30, 30] });
  } else {
    mapInstance.setView([restaurantLocation.lat, restaurantLocation.lng], 15);
  }
}

function resetToMenu() {
  activeOrder = null;
  sessionStorage.removeItem('luxe_active_order');
  switchTab('menu');
}

// Switch between navigation tabs
function switchTab(tabId) {
  // Hide all main containers
  document.getElementById('menuView').style.display = 'none';
  document.getElementById('cartView').style.display = 'none';
  document.getElementById('trackingView').style.display = 'none';
  
  // Remove active class from all nav items
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // Show selected container and highlight nav item
  if (tabId === 'menu') {
    document.getElementById('menuView').style.display = 'block';
    document.getElementById('nav-menu').classList.add('active');
    document.getElementById('cartTrigger').style.display = activeOrder ? 'none' : 'flex';
  } else if (tabId === 'cart') {
    document.getElementById('cartView').style.display = 'block';
    document.getElementById('nav-cart').classList.add('active');
    renderCartDrawer();
    document.getElementById('cartTrigger').style.display = activeOrder ? 'none' : 'flex';
  } else if (tabId === 'status') {
    document.getElementById('trackingView').style.display = 'block';
    document.getElementById('nav-status').classList.add('active');
    document.getElementById('cartTrigger').style.display = 'none';
    
    const trackingContent = document.getElementById('trackingContent');
    const trackingPlaceholder = document.getElementById('trackingPlaceholder');
    
    if (activeOrder) {
      trackingContent.style.display = 'block';
      trackingPlaceholder.style.display = 'none';
      updateTrackingUI();
      initTrackingMap();
    } else {
      trackingContent.style.display = 'none';
      trackingPlaceholder.style.display = 'block';
    }
  }
}
