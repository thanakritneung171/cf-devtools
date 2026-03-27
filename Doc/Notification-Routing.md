# Notification Routing — Deep Dive

> อธิบายกลไกภายในว่า `/api/notifications/push` รู้ได้อย่างไรว่าต้องส่ง notification ไปหา WebSocket ของ user คนไหน

---

## 1. กุญแจสำคัญ: `idFromName(user_id)`

ระบบไม่ได้ใช้ตาราง lookup หรือ in-memory map ใดทั้งสิ้น
routing ทั้งหมดมาจาก **Durable Object ID ที่ deterministic**

```
env.NOTIFICATION_DO.idFromName("123")
```

- รับ string → คืน DO ID ที่แน่นอน ไม่เปลี่ยนแปลง
- เรียกกี่ครั้ง, จาก Worker instance ไหน, เวลาไหน → ได้ **ID เดิมเสมอ**
- นั่นหมายความว่า user_id `"123"` จะชี้ไปยัง DO instance เดียวกันเสมอ

```
user_id: "123"  →  idFromName("123")  →  DO instance A  (เก็บ WS ของ user 123)
user_id: "456"  →  idFromName("456")  →  DO instance B  (เก็บ WS ของ user 456)
```

---

## 2. Flow ทีละขั้น

### 2.1 Frontend เชื่อมต่อ (`/ws`)

```
Frontend: GET /api/notifications/ws?user_id=123
                ↓
notifications.ts (Worker Route):
  const id   = env.NOTIFICATION_DO.idFromName("123")  // → DO ID ของ user 123
  const stub = env.NOTIFICATION_DO.get(id)            // → ดึง instance นั้นมา
  return stub.fetch("/ws", { headers: request.headers })
                ↓
NotificationDO.fetch("/ws"):
  const pair             = new WebSocketPair()
  const [client, server] = Object.values(pair)

  this.state.acceptWebSocket(server)    // ← เก็บ connection ไว้ใน DO นี้
  await this.flushInbox(server)         // ← ส่ง missed notifications ที่ค้างไว้

  return new Response(null, {
    status:    101,
    webSocket: client,                  // ← ส่ง client end กลับ frontend
  })
```

ผล: WebSocket ถูกเก็บไว้ใน DO instance ของ user 123 เท่านั้น

---

### 2.2 Push notification (`/push`)

```
POST /api/notifications/push
Body: { user_id: 123, type: "queue_status_changed", message: "ถึงคิวคุณแล้ว!" }
                ↓
notifications.ts (Worker Route):
  const { user_id, ...payload } = body
  const id   = env.NOTIFICATION_DO.idFromName("123")  // ← ID เดิมกับตอน /ws !
  const stub = env.NOTIFICATION_DO.get(id)            // ← instance เดิม
  return stub.fetch("/push", { method: "POST", body: JSON.stringify(payload) })
                ↓
NotificationDO.fetch("/push"):
  const sockets = this.state.getWebSockets()   // ← ดึง WS ทุกอันใน instance นี้
  let sent = 0
  for (const ws of sockets) {
    ws.send(message)    // ← ส่งไปทุก tab ที่ user 123 เปิดอยู่
    sent++
  }

  if (sent === 0) {
    await this.addToInbox(payload)    // ← user offline → เก็บไว้ก่อน
  }

  return { sent, queued: sent === 0, total_connected: sockets.length }
```

---

## 3. ทำไม DO ถึง "รู้จัก" WebSocket ของ user

```
┌─────────────────────────────────────────────────┐
│  NotificationDO instance ["123"]                │
│                                                 │
│  state.getWebSockets() → [ws_tab1, ws_tab2]     │
│                                                 │
│  storage: { inbox: [...missed messages] }       │
└─────────────────────────────────────────────────┘
```

เมื่อ frontend เรียก `/ws?user_id=123` → Worker หา DO instance ของ `"123"` แล้ว forward request ไป
DO รับ WebSocket upgrade และเรียก `state.acceptWebSocket(server)` → **Cloudflare เก็บ connection ไว้ใน instance นั้น**
เมื่อ `/push` เรียก `state.getWebSockets()` ใน instance เดียวกัน → ได้ connection ของ user 123 คืนมา

ไม่มีการส่ง user_id ข้าม DO — แต่ละ DO รู้เฉพาะ socket ของตัวเอง

---

## 4. Offline / Inbox

```
ถ้า user offline ตอน /push:
  sent = 0
  → addToInbox(payload)
  → เก็บใน DO storage key "inbox"
  → สูงสุด 50 ข้อความ (INBOX_LIMIT)
  → ถ้าเกินจะ slice เอาแค่ล่าสุด 50 อัน

ตอน user กลับมา connect (/ws):
  → flushInbox(server) ถูกเรียกทันทีหลัง acceptWebSocket
  → ส่ง missed messages ทุกอันออกทาง WebSocket
  → แต่ละ message จะมี _inbox: true บอก frontend ว่ามาจาก missed queue
  → ล้าง inbox ใน storage หลัง flush สำเร็จ
```

**InboxMessage format:**
```json
{
  "id": "uuid-...",
  "payload": { "type": "...", "message": "..." },
  "created_at": "2026-03-27T10:00:00.000Z"
}
```

**เมื่อ flush ออก frontend จะได้:**
```json
{
  "type": "queue_status_changed",
  "message": "...",
  "_inbox": true,
  "_inbox_id": "uuid-...",
  "_inbox_created_at": "2026-03-27T10:00:00.000Z"
}
```

---

## 5. Multi-tab Support

user คนเดียวสามารถเปิด browser หลาย tab ได้
ทุก tab จะ connect เข้า DO instance เดียวกัน (เพราะ user_id เดิม)
`state.getWebSockets()` จะคืน array ของ WebSocket ทุก tab
`/push` จะ loop ส่งครบทุก tab

```
Tab 1: GET /ws?user_id=123  →  DO["123"]  acceptWebSocket(ws1)
Tab 2: GET /ws?user_id=123  →  DO["123"]  acceptWebSocket(ws2)

POST /push { user_id: 123, ... }
  → getWebSockets() → [ws1, ws2]
  → ws1.send(...)
  → ws2.send(...)
  → sent: 2
```

---

## 6. Ping / Keep-alive

DO ส่วน `webSocketMessage` รองรับ `ping` action:

```
Frontend → ws.send({ action: "ping" })
DO       → ws.send({ action: "pong", ts: Date.now() })
```

ช่วยให้ connection ไม่ถูกตัดจาก idle timeout
แนะนำให้ frontend ส่ง ping ทุก 30 วินาที

---

## 7. สรุป Routing ในหนึ่งประโยค

> `idFromName(user_id)` ทำให้ `/ws` และ `/push` ชี้ไปหา **DO instance เดียวกัน** ของ user คนนั้น — DO instance นั้นเก็บ WebSocket connections ทั้งหมดของ user ไว้ภายใน ทำให้ push ถึงตัวได้โดยตรง
