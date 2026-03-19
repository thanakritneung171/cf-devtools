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
  <div class="grid">

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

    async function apiCall(url, options) {
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
      let html = '<table><tr><th>Queue ID</th><th>User</th><th>Qty</th><th>Status</th><th>Expires At</th><th>Time Remaining</th><th>Actions</th></tr>';
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
