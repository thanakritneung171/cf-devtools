export function getTicketQueueTestPage(): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ticket Queue Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; color: #333; padding: 20px; }
    h1 { text-align: center; margin-bottom: 24px; color: #1a1a2e; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 1200px; margin: 0 auto; }
    .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 16px; margin-bottom: 12px; color: #1a1a2e; border-bottom: 2px solid #4361ee; padding-bottom: 6px; }
    .card.full { grid-column: 1 / -1; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #555; }
    input { width: 100%; padding: 8px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 10px; }
    input:focus { outline: none; border-color: #4361ee; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; color: #fff; }
    .btn-primary { background: #4361ee; }
    .btn-primary:hover { background: #3a56d4; }
    .btn-success { background: #2ec4b6; }
    .btn-success:hover { background: #25a99d; }
    .btn-danger { background: #e63946; }
    .btn-danger:hover { background: #cf3240; }
    .btn-secondary { background: #6c757d; }
    .btn-secondary:hover { background: #5a6268; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .form-row { display: flex; gap: 8px; align-items: flex-end; }
    .form-row > div { flex: 1; }
    .result { margin-top: 12px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 4px; padding: 10px; font-size: 13px; max-height: 400px; overflow-y: auto; }
    .result pre { white-space: pre-wrap; word-break: break-all; }
    .loading { color: #888; font-style: italic; }
    .error { color: #e63946; }
    .success { color: #2ec4b6; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
    th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover { background: #f8f9fa; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: #fff; }
    .badge-active { background: #4361ee; }
    .badge-waiting { background: #ffc107; color: #333; }
    .badge-completed { background: #2ec4b6; }
    .badge-cancelled { background: #e63946; }
    .badge-blocked { background: #6c757d; }
    .badge-expired { background: #adb5bd; }
    .badge-booked { background: #7209b7; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Ticket Queue Test Dashboard</h1>
  <div style="max-width:1200px;margin:0 auto 16px;">
    <div class="card">
      <h2>Login & Auth Token</h2>
      <div class="form-row">
        <div><label>email</label><input type="text" id="login-email" value="thanachot.j@softdebut.com"></div>
        <div><label>password</label><input type="password" id="login-password" value="12345678"></div>
        <div style="flex:0;padding-bottom:10px;"><button class="btn-primary" onclick="doLogin()">Login</button></div>
      </div>
      <div class="form-row">
        <div style="flex:3"><label>Bearer Token (auto-filled after login, or paste manually)</label><input type="text" id="auth-token" placeholder="token will appear here after login..."></div>
      </div>
      <div id="login-result" class="result" style="display:none;"></div>
    </div>
  </div>
  <div class="grid">

    <!-- Create Product with Image -->
    <div class="card full">
      <h2>Create Product (with Image)</h2>
      <div class="form-row">
        <div><label>product_name</label><input type="text" id="prod-name" placeholder="e.g. iPhone 16"></div>
        <div><label>price</label><input type="number" id="prod-price" placeholder="e.g. 29900" step="0.01"></div>
        <div><label>total_quantity</label><input type="number" id="prod-total" placeholder="e.g. 100"></div>
      </div>
      <div class="form-row">
        <div><label>user_id</label><input type="number" id="prod-user-id" placeholder="e.g. 1"></div>
        <div><label>description</label><input type="text" id="prod-desc" placeholder="(optional)"></div>
        <div><label>image</label><input type="file" id="prod-file" accept="image/*" style="padding:5px;"></div>
      </div>
      <button class="btn-primary" onclick="createProduct()">Create Product</button>
      <div id="product-create-result" class="result" style="display:none;"></div>
    </div>

    <!-- Product List -->
    <div class="card full">
      <h2>Product List</h2>
      <div class="form-row">
        <div><label>page</label><input type="number" id="prodlist-page" value="1" min="1"></div>
        <div><label>limit</label><input type="number" id="prodlist-limit" value="10" min="1"></div>
        <div><label>search</label><input type="text" id="prodlist-search" placeholder="(optional)"></div>
        <div style="flex:0"><button class="btn-primary" onclick="loadProducts()">Load</button></div>
      </div>
      <div id="prodlist-result" class="result" style="display:none;"></div>
    </div>

    <!-- Smart Search -->
    <div class="card full">
      <h2>Smart Search (Semantic + Price Filter)</h2>
      <div class="form-row">
        <div style="flex:2"><label>search query</label><input type="text" id="search-q" placeholder="e.g. phone, laptop..."></div>
        <div><label>minPrice</label><input type="number" id="search-min" placeholder="(optional)" step="0.01"></div>
        <div><label>maxPrice</label><input type="number" id="search-max" placeholder="(optional)" step="0.01"></div>
        <div><label>topK</label><input type="number" id="search-topk" value="5" min="1"></div>
        <div style="flex:0"><button class="btn-primary" onclick="smartSearch()">Search</button></div>
      </div>
      <div id="search-result" class="result" style="display:none;"></div>
    </div>

    <!-- Bookings List -->
    <div class="card full">
      <h2>Bookings List</h2>
      <div class="form-row">
        <div><label>page</label><input type="number" id="bookings-page" value="1" min="1"></div>
        <div><label>limit</label><input type="number" id="bookings-limit" value="10" min="1"></div>
        <div style="flex:0"><button class="btn-primary" onclick="loadBookings()">Load</button></div>
      </div>
      <div id="bookings-result" class="result" style="display:none;"></div>
    </div>

    <hr style="grid-column:1/-1; border:none; border-top:2px solid #4361ee; margin:8px 0;">

    <!-- 1. Create Booking -->
    <div class="card">
      <h2>Create Booking</h2>
      <div class="form-row">
        <div><label>user_id</label><input type="number" id="booking-user-id" placeholder="e.g. 1"></div>
        <div><label>product_id</label><input type="number" id="booking-product-id" placeholder="e.g. 1"></div>
        <div><label>quantity</label><input type="number" id="booking-quantity" value="1" min="1"></div>
      </div>
      <button class="btn-primary" onclick="createBooking()">Create Booking</button>
      <div id="booking-result" class="result" style="display:none;"></div>
    </div>

    <!-- 2. Stock Info -->
    <div class="card">
      <h2>Stock Info (by product_id)</h2>
      <div class="form-row">
        <div><label>product_id</label><input type="number" id="stock-product-id" placeholder="e.g. 1"></div>
        <div style="flex:0"><button class="btn-primary" onclick="loadStock()">Load</button></div>
      </div>
      <div id="stock-result" class="result" style="display:none;"></div>
    </div>

    <!-- 3. Queue All -->
    <div class="card full">
      <h2>Queue All (all products)</h2>
      <button class="btn-primary" onclick="loadQueueAll()">Load Queue All</button>
      <div id="queue-all-result" class="result" style="display:none;"></div>
    </div>

    <!-- 4. Queue by User -->
    <div class="card full">
      <h2>Queue by User</h2>
      <div class="form-row">
        <div><label>user_id</label><input type="number" id="queue-user-id" placeholder="e.g. 1"></div>
        <div style="flex:0"><button class="btn-primary" onclick="loadQueueByUser()">Load</button></div>
      </div>
      <div id="queue-user-result" class="result" style="display:none;"></div>
    </div>

  </div>

  <script>
    const API = '/api/ticket-queue-test';

    function showResult(elId, content, isError) {
      const el = document.getElementById(elId);
      el.style.display = 'block';
      el.innerHTML = '<pre class="' + (isError ? 'error' : '') + '">' + escapeHtml(content) + '</pre>';
    }

    function showHtml(elId, html) {
      const el = document.getElementById(elId);
      el.style.display = 'block';
      el.innerHTML = html;
    }

    function showLoading(elId) {
      const el = document.getElementById(elId);
      el.style.display = 'block';
      el.innerHTML = '<span class="loading">Loading...</span>';
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function badgeFor(status) {
      const s = (status || '').toLowerCase();
      const cls = {
        active: 'badge-active',
        waiting: 'badge-waiting',
        completed: 'badge-completed',
        cancelled: 'badge-cancelled',
        blocked: 'badge-blocked',
        expired: 'badge-expired',
        booked: 'badge-booked',
      }[s] || 'badge-blocked';
      return '<span class="badge ' + cls + '">' + escapeHtml(status) + '</span>';
    }

    function formatValue(v) {
      if (v === null || v === undefined) return '<span style="color:#aaa;">null</span>';
      if (typeof v === 'object') return '<pre style="margin:0;">' + escapeHtml(JSON.stringify(v, null, 2)) + '</pre>';
      return escapeHtml(String(v));
    }

    function formatStock(stock) {
      if (stock === null || stock === undefined) return 'N/A';
      if (typeof stock === 'object') return JSON.stringify(stock);
      return String(stock);
    }

    function formatTimeRemaining(seconds) {
      if (seconds <= 0) return '<span style="color:#e63946;">Expired</span>';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function getAuthHeaders() {
      const token = document.getElementById('auth-token').value;
      return token ? { 'Authorization': 'Bearer ' + token } : {};
    }

    async function apiCall(url, options) {
      options = options || {};
      const authHeaders = getAuthHeaders();
      if (options.headers) {
        Object.assign(options.headers, authHeaders);
      } else if (options.body instanceof FormData) {
        options.headers = authHeaders;
      } else {
        options.headers = { ...authHeaders, ...(options.headers || {}) };
      }
      const res = await fetch(url, options);
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    }

    // 1. Create Booking
    async function createBooking() {
      const userId = document.getElementById('booking-user-id').value;
      const productId = document.getElementById('booking-product-id').value;
      const quantity = document.getElementById('booking-quantity').value;
      if (!userId || !productId) { alert('Please fill user_id and product_id'); return; }
      showLoading('booking-result');
      try {
        const { ok, data } = await apiCall(API + '/booking', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: parseInt(userId), product_id: parseInt(productId), quantity: parseInt(quantity) })
        });
        showResult('booking-result', JSON.stringify(data, null, 2), !ok);
      } catch (e) {
        showResult('booking-result', 'Error: ' + e.message, true);
      }
    }

    // 2. Load Stock
    async function loadStock() {
      const productId = document.getElementById('stock-product-id').value;
      if (!productId) { alert('Please fill product_id'); return; }
      showLoading('stock-result');
      try {
        const { ok, data } = await apiCall(API + '/stock?product_id=' + productId);
        if (!ok) { showResult('stock-result', JSON.stringify(data, null, 2), true); return; }
        let html = '<table><tr><th>Field</th><th>Value</th></tr>';
        for (const [k, v] of Object.entries(data)) {
          if (k === 'queue') continue;
          html += '<tr><td>' + escapeHtml(k) + '</td><td>' + formatValue(v) + '</td></tr>';
        }
        html += '</table>';
        if (data.queue && data.queue.length > 0) {
          html += renderQueueTable(data.queue, productId);
        }
        showHtml('stock-result', html);
      } catch (e) {
        showResult('stock-result', 'Error: ' + e.message, true);
      }
    }

    // 3. Queue All
    async function loadQueueAll() {
      showLoading('queue-all-result');
      try {
        const { ok, data } = await apiCall(API + '/queue-all');
        if (!ok) { showResult('queue-all-result', JSON.stringify(data, null, 2), true); return; }
        if (!data.data || data.data.length === 0) {
          showHtml('queue-all-result', '<p style="color:#888;">No queues found.</p>');
          return;
        }
        let html = '<p><strong>Products with queue:</strong> ' + data.products_with_queue + '</p>';
        for (const product of data.data) {
          html += '<h3 style="margin-top:12px;">Product #' + product.product_id + ' (stock: ' + formatStock(product.stock) + ', available: ' + (product.effective_available != null ? product.effective_available : 'N/A') + ')</h3>';
          if (product.queue && product.queue.length > 0) {
            html += renderQueueTable(product.queue, product.product_id);
          } else {
            html += '<p style="color:#888;">No queue entries</p>';
          }
        }
        showHtml('queue-all-result', html);
      } catch (e) {
        showResult('queue-all-result', 'Error: ' + e.message, true);
      }
    }

    // 4. Queue by User
    async function loadQueueByUser() {
      const userId = document.getElementById('queue-user-id').value;
      if (!userId) { alert('Please fill user_id'); return; }
      showLoading('queue-user-result');
      try {
        const { ok, data } = await apiCall(API + '/queue/user?user_id=' + userId);
        if (!ok) { showResult('queue-user-result', JSON.stringify(data, null, 2), true); return; }
        let html = '';
        if (data.user) {
          html += '<p><strong>User:</strong> ' + escapeHtml((data.user.first_name || '') + ' ' + (data.user.last_name || '')) + ' (' + escapeHtml(data.user.email || '') + ')</p>';
        }
        html += '<p><strong>Products:</strong> ' + data.total_products + '</p>';
        if (!data.data || data.data.length === 0) {
          html += '<p style="color:#888;">No queue entries for this user</p>';
          showHtml('queue-user-result', html);
          return;
        }
        for (const item of data.data) {
          html += '<h3 style="margin-top:12px;">Product #' + item.product_id + ' (stock: ' + formatStock(item.stock) + ', available: ' + (item.effective_available != null ? item.effective_available : 'N/A') + ')</h3>';
          html += renderQueueTable(item.queue_entries, item.product_id);
        }
        showHtml('queue-user-result', html);
      } catch (e) {
        showResult('queue-user-result', 'Error: ' + e.message, true);
      }
    }

    // Render queue table with Complete/Cancel buttons
    function renderQueueTable(queue, productId) {
      const hasQueueInfo = queue.some(e => e.total_in_queue != null);
      let html = '<table><tr><th>Queue ID</th><th>User</th><th>Qty</th><th>Status</th>';
      if (hasQueueInfo) {
        html += '<th>Total in Queue</th><th>Waiting Ahead</th><th>Booked Ahead</th>';
      }
      html += '<th>Expires At</th><th>Time Remaining</th><th>Actions</th></tr>';
      for (const entry of queue) {
        const qid = entry.id;
        const st = (entry.status || '').toLowerCase();
        const canAct = st === 'active' || st === 'waiting' || st === 'booked';
        const userName = entry.user ? escapeHtml((entry.user.first_name || '') + ' ' + (entry.user.last_name || '')) : String(entry.user_id || '-');
        const expiresAt = entry.expires_at ? new Date(entry.expires_at).toLocaleString('th-TH') : '-';
        const timeRemaining = entry.time_remaining_seconds != null ? formatTimeRemaining(entry.time_remaining_seconds) : '-';
        html += '<tr>';
        html += '<td>' + qid + '</td>';
        html += '<td>' + userName + '</td>';
        html += '<td>' + (entry.quantity || '-') + '</td>';
        html += '<td>' + badgeFor(entry.status) + '</td>';
        if (hasQueueInfo) {
          html += '<td style="text-align:center;">' + (entry.total_in_queue != null ? entry.total_in_queue : '-') + '</td>';
          html += '<td style="text-align:center;">' + (entry.waiting_ahead != null ? '<span style="color:#f4a261;font-weight:600;">' + entry.waiting_ahead + '</span>' : '-') + '</td>';
          html += '<td style="text-align:center;">' + (entry.booked_ahead != null ? '<span style="color:#7209b7;font-weight:600;">' + entry.booked_ahead + '</span>' : '-') + '</td>';
        }
        html += '<td>' + expiresAt + '</td>';
        html += '<td>' + timeRemaining + '</td>';
        html += '<td>';
        if (canAct) {
          html += '<button class="btn-success btn-sm" onclick="completeBooking(' + qid + ',' + productId + ')">Complete</button> ';
          html += '<button class="btn-danger btn-sm" onclick="cancelBooking(' + qid + ',' + productId + ')">Cancel</button>';
        } else {
          html += '<span style="color:#aaa;">-</span>';
        }
        html += '</td></tr>';
      }
      html += '</table>';
      return html;
    }

    // 5. Complete booking
    async function completeBooking(queueId, productId) {
      if (!confirm('Complete queue #' + queueId + '?')) return;
      try {
        const { ok, data } = await apiCall(API + '/booking/' + queueId + '/complete?product_id=' + productId, { method: 'PUT' });
        alert(ok ? 'Completed!' : 'Error: ' + JSON.stringify(data));
        refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // 6. Cancel booking
    async function cancelBooking(queueId, productId) {
      if (!confirm('Cancel queue #' + queueId + '?')) return;
      try {
        const { ok, data } = await apiCall(API + '/booking/' + queueId + '/cancel?product_id=' + productId, { method: 'PUT' });
        alert(ok ? 'Cancelled!' : 'Error: ' + JSON.stringify(data));
        refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // Login
    async function doLogin() {
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      if (!email || !password) { alert('Please fill email and password'); return; }
      showLoading('login-result');
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password_hash: password })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          document.getElementById('auth-token').value = data.token;
          const u = data.user || {};
          // Auto-fill user_id in all relevant fields
          if (u.id) {
            document.getElementById('booking-user-id').value = u.id;
            document.getElementById('queue-user-id').value = u.id;
            document.getElementById('prod-user-id').value = u.id;
          }
          showHtml('login-result',
            '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
            '<span class="success" style="font-size:15px;">&#10003; Login สำเร็จ</span>' +
            '<span>user_id: <strong>' + u.id + '</strong></span>' +
            '<span>' + escapeHtml((u.first_name || '') + ' ' + (u.last_name || '')) + '</span>' +
            '<span style="color:#888;">' + escapeHtml(u.email || '') + '</span>' +
            (u.role ? '<span class="badge badge-active">' + escapeHtml(u.role) + '</span>' : '') +
            '</div>'
          );
        } else {
          showResult('login-result', JSON.stringify(data, null, 2), true);
        }
      } catch (e) {
        showResult('login-result', 'Error: ' + e.message, true);
      }
    }

    // Create Product with Image
    async function createProduct() {
      const name = document.getElementById('prod-name').value;
      const price = document.getElementById('prod-price').value;
      const total = document.getElementById('prod-total').value;
      const userId = document.getElementById('prod-user-id').value;
      const desc = document.getElementById('prod-desc').value;
      const fileInput = document.getElementById('prod-file');
      if (!name || !price || !total || !userId) { alert('Please fill product_name, price, total_quantity, user_id'); return; }
      showLoading('product-create-result');
      try {
        const fd = new FormData();
        fd.append('product_name', name);
        fd.append('price', price);
        fd.append('total_quantity', total);
        fd.append('available_quantity', total);
        fd.append('user_id', userId);
        if (desc) fd.append('description', desc);
        if (fileInput.files[0]) fd.append('file', fileInput.files[0]);
        const { ok, data } = await apiCall('/api/productPOCimage', { method: 'POST', body: fd });
        showResult('product-create-result', JSON.stringify(data, null, 2), !ok);
      } catch (e) {
        showResult('product-create-result', 'Error: ' + e.message, true);
      }
    }

    // Product List
    async function loadProducts() {
      const page = document.getElementById('prodlist-page').value || '1';
      const limit = document.getElementById('prodlist-limit').value || '10';
      const search = document.getElementById('prodlist-search').value;
      showLoading('prodlist-result');
      try {
        let url = '/api/productPOC?page=' + page + '&limit=' + limit;
        if (search) url += '&search=' + encodeURIComponent(search);
        const { ok, data } = await apiCall(url);
        if (!ok) { showResult('prodlist-result', JSON.stringify(data, null, 2), true); return; }
        if (!data.data || data.data.length === 0) {
          showHtml('prodlist-result', '<p style="color:#888;">No products found.</p>');
          return;
        }
        const pg = data.pagination;
        let html = '<p><strong>Page:</strong> ' + pg.page + '/' + pg.total_pages + ' | <strong>Total:</strong> ' + pg.total + '</p>';
        html += '<table><tr><th>ID</th><th>Image</th><th>Name</th><th>Description</th><th>Price</th><th>Stock</th><th>Created</th></tr>';
        for (const p of data.data) {
          html += '<tr>';
          html += '<td>' + p.id + '</td>';
          html += '<td>' + (p.image_url ? '<img src="' + escapeHtml(p.image_url) + '" style="width:40px;height:40px;object-fit:cover;border-radius:4px;">' : '-') + '</td>';
          html += '<td>' + escapeHtml(p.product_name || '') + '</td>';
          html += '<td>' + escapeHtml(p.description || '-') + '</td>';
          html += '<td>' + (p.price != null ? p.price.toLocaleString() : '-') + '</td>';
          html += '<td>' + (p.available_quantity != null ? p.available_quantity + '/' + p.total_quantity : '-') + '</td>';
          html += '<td>' + (p.created_at ? new Date(p.created_at).toLocaleString('th-TH') : '-') + '</td>';
          html += '</tr>';
        }
        html += '</table>';
        showHtml('prodlist-result', html);
      } catch (e) {
        showResult('prodlist-result', 'Error: ' + e.message, true);
      }
    }

    // Smart Search
    async function smartSearch() {
      const q = document.getElementById('search-q').value;
      if (!q) { alert('Please fill search query'); return; }
      const minPrice = document.getElementById('search-min').value;
      const maxPrice = document.getElementById('search-max').value;
      const topK = document.getElementById('search-topk').value || '5';
      showLoading('search-result');
      try {
        let url = '/api/productPOC/smart-search?q=' + encodeURIComponent(q) + '&topK=' + topK;
        if (minPrice) url += '&minPrice=' + minPrice;
        if (maxPrice) url += '&maxPrice=' + maxPrice;
        const { ok, data } = await apiCall(url);
        if (!ok) { showResult('search-result', JSON.stringify(data, null, 2), true); return; }
        if (!data.results || data.results.length === 0) {
          showHtml('search-result', '<p style="color:#888;">No results found.</p>');
          return;
        }
        let html = '<p><strong>Query:</strong> ' + escapeHtml(data.query) + ' | <strong>Results:</strong> ' + data.total + '</p>';
        html += '<table><tr><th>ID</th><th>Image</th><th>Name</th><th>Description</th><th>Price</th><th>Stock</th><th>Score</th></tr>';
        for (const p of data.results) {
          html += '<tr>';
          html += '<td>' + p.id + '</td>';
          html += '<td>' + (p.image_url ? '<img src="' + escapeHtml(p.image_url) + '" style="width:40px;height:40px;object-fit:cover;border-radius:4px;">' : '-') + '</td>';
          html += '<td>' + escapeHtml(p.product_name || '') + '</td>';
          html += '<td>' + escapeHtml(p.description || '-') + '</td>';
          html += '<td>' + (p.price != null ? p.price.toLocaleString() : '-') + '</td>';
          html += '<td>' + (p.available_quantity != null ? p.available_quantity + '/' + p.total_quantity : '-') + '</td>';
          html += '<td>' + (p.score != null ? p.score.toFixed(4) : '-') + '</td>';
          html += '</tr>';
        }
        html += '</table>';
        showHtml('search-result', html);
      } catch (e) {
        showResult('search-result', 'Error: ' + e.message, true);
      }
    }

    // Bookings List
    async function loadBookings() {
      const page = document.getElementById('bookings-page').value || '1';
      const limit = document.getElementById('bookings-limit').value || '10';
      showLoading('bookings-result');
      try {
        const { ok, data } = await apiCall('/api/bookings?page=' + page + '&limit=' + limit);
        if (!ok) { showResult('bookings-result', JSON.stringify(data, null, 2), true); return; }
        if (!data.data || data.data.length === 0) {
          showHtml('bookings-result', '<p style="color:#888;">No bookings found.</p>');
          return;
        }
        const pg = data.pagination;
        let html = '<p><strong>Page:</strong> ' + pg.page + '/' + pg.total_pages + ' | <strong>Total:</strong> ' + pg.total + '</p>';
        html += '<table><tr><th>ID</th><th>User</th><th>Product</th><th>Image</th><th>Qty</th><th>Price</th><th>Sum</th><th>Status</th><th>Date</th></tr>';
        for (const b of data.data) {
          const prod = b.product || {};
          html += '<tr>';
          html += '<td>' + b.id + '</td>';
          html += '<td>' + escapeHtml((b.first_name || '') + ' ' + (b.last_name || '')) + '</td>';
          html += '<td>' + escapeHtml(prod.product_name || '-') + '</td>';
          html += '<td>' + (prod.image_url ? '<img src="' + escapeHtml(prod.image_url) + '" style="width:40px;height:40px;object-fit:cover;border-radius:4px;">' : '-') + '</td>';
          html += '<td>' + (b.quantity || '-') + '</td>';
          html += '<td>' + (prod.price != null ? prod.price.toLocaleString() : '-') + '</td>';
          html += '<td>' + (b.sumPrice != null ? b.sumPrice.toLocaleString() : '-') + '</td>';
          html += '<td>' + badgeFor(b.status || '') + '</td>';
          html += '<td>' + (b.booking_date ? new Date(b.booking_date).toLocaleString('th-TH') : '-') + '</td>';
          html += '</tr>';
        }
        html += '</table>';
        showHtml('bookings-result', html);
      } catch (e) {
        showResult('bookings-result', 'Error: ' + e.message, true);
      }
    }

    // Auto-refresh visible sections
    function refreshAll() {
      const stockPid = document.getElementById('stock-product-id').value;
      if (stockPid) loadStock();
      if (document.getElementById('queue-all-result').style.display !== 'none') loadQueueAll();
      const queueUid = document.getElementById('queue-user-id').value;
      if (queueUid && document.getElementById('queue-user-result').style.display !== 'none') loadQueueByUser();
    }
  </script>
</body>
</html>`;
}
