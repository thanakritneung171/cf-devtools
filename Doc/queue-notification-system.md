# Queue Notification System

## 1. Overview

ระบบแจ้งเตือนคิวแบบ **real-time** โดยไม่ต้องรีเฟรชหน้าจอ
ใช้ **Cloudflare Durable Objects + WebSocket** เป็น backend
เมื่อสถานะคิวของผู้ใช้เปลี่ยน ระบบจะ push notification ไปถึงหน้าจอทันที

---

## 2. หลักการ (Concept)

### 2.1 ทำไมต้องใช้ WebSocket

| วิธี | ลักษณะ | ข้อดี | ข้อเสีย |
|------|--------|-------|---------|
| **Polling** | frontend เรียก API ทุก N วินาที | ง่าย | เปลือง bandwidth, หน่วง |
| **WebSocket** | เปิด connection ค้างไว้ server push ได้ทันที | real-time, ประหยัด | ต้องมี stateful server |
| **SSE** | server push ทางเดียว | ง่ายกว่า WS | ไม่ bi-directional |

เลือก **WebSocket** เพราะ Cloudflare Durable Objects รองรับ natively และต้องการ real-time แท้จริง

---

### 2.2 ทำไมต้องใช้ Durable Objects

Cloudflare Workers ปกติเป็น **stateless** — ทุก request อาจรันบน instance คนละตัว
ทำให้ไม่สามารถเก็บ WebSocket connection ค้างไว้ได้

**Durable Objects (DO)** แก้ปัญหานี้:
- แต่ละ DO instance เป็น **single-threaded, stateful**
- ใช้ `idFromName(user_id)` → ทำให้ user คนเดียวกันเข้าถึง DO instance เดียวกันเสมอ
- สามารถเก็บ WebSocket connections หลายอันต่อ user ได้ (multi-tab)

```
user_id: 123  →  NotificationDO["123"]  →  เก็บ WebSocket ของ user 123 ทุก tab
user_id: 456  →  NotificationDO["456"]  →  เก็บ WebSocket ของ user 456 ทุก tab
```

---

### 2.3 Hibernatable WebSocket API

ใช้ `state.acceptWebSocket(server)` แทน `server.accept()` แบบเก่า
ทำให้ DO **hibernate** ได้เมื่อไม่มี activity — ประหยัด compute cost
และ Cloudflare จะ restore DO กลับมาอัตโนมัติเมื่อมี message เข้า

---

### 2.4 Flow การแจ้งเตือน

```
[Frontend]                    [Worker Route]              [NotificationDO]         [TicketQueueDOTest]
    |                               |                            |                        |
    |-- GET /api/notifications/ws?user_id=123 -->               |                        |
    |                               |--- idFromName("123") ---->|                        |
    |                               |<-- WebSocket upgrade -----| (เก็บ connection)      |
    |<====== WebSocket open ========|                            |                        |
    |                               |                            |                        |
    |                   (ผู้ใช้อื่น cancel booking)              |                        |
    |                               |                    [TicketQueueDOTest.cancel-booking]
    |                               |                            |<-- /push { user_id: 123, ... }
    |<== { type: "queue_status_changed", status: "booked" } =====|
    |                               |                            |
    | [แสดง popup "ถึงคิวคุณแล้ว!"] |                            |
```

---

## 3. สถาปัตยกรรม (Architecture)

```
cf-devtools (Cloudflare Worker)
│
├── src/
│   ├── durableObjects/
│   │   ├── TicketQueueDO.ts        ← จัดการคิว (D1-based)
│   │   ├── TicketQueueDOTest.ts    ← จัดการคิว (DO storage-based) + ส่ง noti
│   │   └── NotificationDO.ts       ← [ใหม่] จัดการ WebSocket per user
│   │
│   └── routes/
│       ├── ticketQueueTest.ts      ← API สำหรับคิว
│       └── notifications.ts        ← [ใหม่] API สำหรับ WebSocket + push
│
└── wrangler.jsonc                  ← เพิ่ม NOTIFICATION_DO binding + migration v4
```

---

## 4. ไฟล์ที่สร้าง/แก้ไข

### 4.1 ไฟล์ใหม่

#### `src/durableObjects/NotificationDO.ts`
Durable Object ที่เก็บ WebSocket connections ของ user แต่ละคน

| Endpoint | Method | หน้าที่ |
|----------|--------|---------|
| `/ws` | GET (WebSocket Upgrade) | รับ connection จาก frontend |
| `/push` | POST | ส่ง JSON message ไปยัง client ทุกตัวที่ connect อยู่ |

#### `src/routes/notifications.ts`
Route handler สำหรับ frontend และ internal push

| Endpoint | Method | หน้าที่ |
|----------|--------|---------|
| `/api/notifications/ws?user_id=xxx` | GET | Frontend เชื่อมต่อ WebSocket |
| `/api/notifications/push` | POST | Push notification ให้ user ที่ระบุ |

---

### 4.2 ไฟล์ที่แก้ไข

#### `wrangler.jsonc`
```jsonc
// เพิ่ม DO binding
{
  "name": "NOTIFICATION_DO",
  "class_name": "NotificationDO"
}

// เพิ่ม migration
{
  "tag": "v4",
  "new_classes": ["NotificationDO"]
}
```

#### `src/index.ts`
- export `NotificationDO`
- import + register `handleNotificationRoutes`

#### `src/durableObjects/TicketQueueDOTest.ts`
เพิ่ม method `notifyPromotedUsers()` และเรียกใน:
- `processExpired()` — เมื่อ booking หมดเวลา → promote คนถัดไป
- `complete-booking` handler — เมื่อ complete → promote คนถัดไป
- `cancel-booking` handler — เมื่อ cancel → promote คนถัดไป
- `sync-stock` handler — เมื่อ stock เปลี่ยน → recalculate ทั้งคิว
- `edit-quantity` handler — เมื่อ user แก้จำนวน → อาจ promote ตัวเอง

---

## 5. Notification Payload

ทุก event ที่ส่งมาจาก server จะมีรูปแบบนี้:

```json
{
  "type": "queue_status_changed",
  "product_id": 1,
  "queue_id": 42,
  "status": "booked",
  "message": "ถึงคิวคุณแล้ว! กรุณายืนยันการจองก่อนหมดเวลา",
  "expires_at": "2026-03-25T10:30:00.000Z"
}
```

### สถานะที่ trigger notification

| `status` | เงื่อนไข | เกิดจาก | ข้อความ |
|----------|---------|---------|---------|
| `booked` | ถึงคิวแล้ว stock พอ | promote จาก waiting | "ถึงคิวคุณแล้ว! กรุณายืนยันการจองก่อนหมดเวลา" |
| `waiting_edit` | ถึงคิวแล้ว แต่ stock ไม่พอกับจำนวนที่จอง | promote จาก waiting | "ถึงคิวคุณแล้ว แต่จำนวนที่จองเกินสินค้าที่เหลือ กรุณาแก้ไขจำนวน" |
| `out_of_stock` | ถึงคิวแล้ว แต่สินค้าหมดแล้ว | promote จาก waiting | "ถึงคิวคุณแล้ว แต่สินค้าหมดแล้ว กรุณาตรวจสอบ" |
| `expired` | booking หมดเวลา (ไม่ยืนยันใน 2.5 นาที) | alarm / processExpired | "หมดเวลาการจองของคุณแล้ว คิวของคุณถูกยกเลิกอัตโนมัติ" |
| `cancelled` | คิวถูกยกเลิก | cancel-booking API | "คิวของคุณถูกยกเลิกแล้ว" |

**กฎการส่ง:**
- `booked` / `waiting_edit` / `out_of_stock` — ส่งเมื่อ **status เปลี่ยน** (ไม่ซ้ำถ้า status เดิม)
- `expired` / `cancelled` — ส่งให้ **เจ้าของคิวทันที** ก่อนลบออกจากคิว

---

## 6. วิธีใช้งาน (Frontend Integration)

### 6.1 เชื่อมต่อ WebSocket

```javascript
const userId = 123; // user_id จาก session/token
const ws = new WebSocket(`wss://your-domain.com/api/notifications/ws?user_id=${userId}`);

ws.onopen = () => {
  console.log("Connected to notification service");
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === "queue_status_changed") {
    switch (data.status) {
      case "booked":
        showToast(`ถึงคิวคุณแล้ว! หมดเวลาใน ${formatCountdown(data.expires_at)}`);
        break;
      case "waiting_edit":
        showToast("กรุณาแก้ไขจำนวนสินค้าที่ต้องการ");
        openEditQuantityModal(data.queue_id, data.product_id);
        break;
      case "out_of_stock":
        showToast("สินค้าหมดแล้ว");
        break;
    }
  }
};

ws.onerror = (err) => console.error("WebSocket error:", err);
ws.onclose = () => console.log("Disconnected");
```

### 6.2 Keep-alive (ป้องกัน connection ถูกตัด)

```javascript
// ส่ง ping ทุก 30 วินาที
const pingInterval = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "ping" }));
  }
}, 30000);

ws.onclose = () => clearInterval(pingInterval);
```

### 6.3 Auto-reconnect

```javascript
function connectWS(userId) {
  const ws = new WebSocket(`wss://your-domain.com/api/notifications/ws?user_id=${userId}`);

  ws.onclose = () => {
    // reconnect หลัง 3 วินาที
    setTimeout(() => connectWS(userId), 3000);
  };

  return ws;
}
```

---

## 7. Push Notification แบบ Manual (Admin/Internal)

ใช้สำหรับส่ง notification ที่ไม่ได้เกิดจาก queue event เช่น ประกาศระบบ

```bash
curl -X POST https://your-domain.com/api/notifications/push \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 123,
    "type": "announcement",
    "message": "ระบบจะปิดปรับปรุงเวลา 22:00 น."
  }'
```

Response:
```json
{
  "sent": 2,
  "total_connected": 2
}
```

---

## 8. Deploy

```bash
# 1. Deploy Worker (Cloudflare จะ apply migration v4 อัตโนมัติ สร้าง NotificationDO)
wrangler deploy

# 2. ตรวจสอบ DO migrations
wrangler durable-objects namespaces list
```

> **หมายเหตุ**: `NotificationDO` ใช้ Hibernatable WebSocket API
> ต้องใช้ `compatibility_date` >= `2023-01-01` (project นี้ใช้ `2026-02-12` ✓)
