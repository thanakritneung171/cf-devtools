# TicketQueueDOTest - Durable Object Queue System

## Overview

ระบบจัดคิวจองสินค้าผ่าน Cloudflare Durable Object
- **DO Storage** = จัดการ queue + stock (single-threaded, strongly consistent)
- **D1** = สร้าง booking + อัปเดต stock ถาวร (เฉพาะตอน complete เท่านั้น)
- **DO instance 1 ตัว ต่อ 1 product** — ใช้ `idFromName(productId)` แยก
- **Booking Expiration** = จองแล้วต้อง complete ภายใน 5 นาที ไม่งั้นถูก auto-cancel

---

## Data Structure (DO Storage)

```typescript
// Storage key: "queue"
interface QueueEntry {
  id: number;            // auto-increment ID (queueId)
  user_id: number;
  product_id: number;
  quantity: number;
  status: 'booked' | 'waiting';
  created_at: string;    // ISO string (UTC+7)
  expires_at: string | null;  // เวลาหมดอายุ (เฉพาะ booked เท่านั้น, waiting = null)
}

// Storage key: "stock"
interface StockInfo {
  product_id: number;
  product_name: string;
  description: string | null;
  price: number;
  total_quantity: number;
  available_quantity: number;  // หักเฉพาะตอน complete เท่านั้น
}

// Storage key: "nextId"
number  // auto-increment counter
```

---

## Stock Logic

### ค่าสำคัญ 2 ตัว

| ค่า | คำอธิบาย | เปลี่ยนตอน |
|---|---|---|
| `stock.available_quantity` | stock จริงที่เหลือ (หักเฉพาะตอน complete) | complete, init |
| `effective_available` | stock ว่างที่จองใหม่ได้ = `available_quantity - sum(booked quantity)` | ทุกครั้งที่ queue เปลี่ยน |

### กฎกำหนด status

```
0. ถ้า quantity > available_quantity → reject ทันที (stock จริงไม่พอ ไม่ต้องรอ)
1. ถ้ามี waiting อยู่ในคิวก่อนหน้า → คนใหม่ต้อง waiting เสมอ (ห้ามข้ามคิว)
2. ถ้าไม่มี waiting + effective >= quantity → booked
3. ถ้าไม่มี waiting + effective < quantity → waiting
```

> **สำคัญ:** เช็คกับ `available_quantity` (stock จริงที่เหลือหลัง complete) ไม่ใช่ `total_quantity`
> เพราะถ้า stock ถูก complete ไปแล้วจนเหลือไม่พอ → รอไปก็ไม่มีทางได้ ควร reject ตั้งแต่แรก

### ตัวอย่าง: สินค้ามี stock = 100

| Step | available_quantity | booked รวม | effective | อธิบาย |
|---|---|---|---|---|
| เริ่มต้น | 100 | 0 | **100** | ยังไม่มีใครจอง |
| คน 1 จอง 40 → booked | 100 | 40 | **60** | ไม่มี waiting, 100-40=60 |
| คน 2 จอง 30 → booked | 100 | 70 | **30** | ไม่มี waiting, 70 ถูกจองแล้ว |
| คน 3 จอง 31 → **waiting** | 100 | 70 | **30** | 30 < 31 stock ไม่พอ |
| คน 4 จอง 9 → **waiting** | 100 | 70 | **30** | มี waiting ก่อนหน้า ห้ามข้ามคิว |
| คน 1 **complete** | **60** | 30 | **30** | stock หัก 40, booked เหลือคน 2 |
| คน 2 **complete** | **30** | 0 | **30** | stock หัก 30, ไม่มี booked |
| recalculate → คน 3 ยัง waiting | 30 | 0 | **30** | 30 < 31 ยังไม่พอ |
| recalculate → คน 4 ก็ยัง waiting | 30 | 0 | **30** | ห้ามข้ามคิว 3 |

> **หมายเหตุ:** recalculate จะ promote ตามลำดับคิวเท่านั้น ถ้าคนแรกใน waiting ไม่พอ → หยุด ไม่ข้ามไปคนถัดไป

### ตัวอย่าง: cancel แล้ว promote หลายคน

| Step | available_quantity | booked รวม | effective |
|---|---|---|---|
| คน 1 จอง 40 → booked | 100 | 40 | 60 |
| คน 2 จอง 30 → booked | 100 | 70 | 30 |
| คน 3 จอง 31 → waiting | 100 | 70 | 30 |
| คน 4 จอง 9 → waiting | 100 | 70 | 30 |
| คน 1 **cancel** | 100 | 30 | **70** |
| recalculate → คน 3 → **booked** | 100 | 61 | **39** |
| recalculate → คน 4 → **booked** | 100 | 70 | **30** |

---

## Booking Expiration (หมดเวลาจอง)

### หลักการ

- เมื่อ queue entry ได้สถานะ `booked` จะตั้งเวลาหมดอายุ (`expires_at`) = **5 นาที**
- ถ้าไม่ complete ภายในเวลา → ถูก **auto-cancel** (ลบออกจากคิวอัตโนมัติ)
- หลัง auto-cancel → recalculate statuses → promote waiting → booked (พร้อมตั้ง expires_at ใหม่)
- `waiting` entry ไม่มี expires_at (จะได้ตอน promote เป็น booked)

### กลไกการทำงาน

```
จอง → booked (expires_at = now + 5min) → DO Alarm ตั้งไว้
  ↓ ถ้า complete ทัน
  → หัก stock + สร้าง booking D1 ✅
  ↓ ถ้าไม่ complete ภายใน 5 นาที
  → alarm() ทำงาน → ลบ entry → recalculate → promote waiting → ตั้ง alarm ใหม่
```

### จุดที่ตั้ง expires_at

| จุด | เงื่อนไข |
|---|---|
| `create-booking` | ถ้าได้ status = `booked` |
| `recalculateStatuses()` | ตอน promote จาก `waiting` → `booked` |

### จุดที่เช็ค expired

| จุด | อธิบาย |
|---|---|
| `alarm()` | DO Alarm — ทำงานอัตโนมัติเมื่อถึงเวลา |
| ทุก request ที่เข้ามา | `processExpired()` เช็คก่อนประมวลผล |

### time_remaining_seconds

ทุก endpoint ที่แสดง queue entry จะมี field `time_remaining_seconds`:
- **booked** → เวลาที่เหลือ (วินาที) ก่อนหมดอายุ
- **waiting** → `null` (ยังไม่มีเวลาหมดอายุ)

### ตัวอย่าง Flow

```
สมมติ stock = 100, timeout = 5 นาที

10:00:00 — คน 1 จอง 40 → booked (expires_at: 10:05:00)
10:01:00 — คน 2 จอง 30 → booked (expires_at: 10:06:00)
10:02:00 — คน 3 จอง 31 → waiting (expires_at: null)
10:03:00 — ดู status คน 1 → time_remaining_seconds: 120 (เหลือ 2 นาที)

10:05:00 — ⏰ Alarm! คน 1 หมดเวลา → auto-cancel
           → recalculate: effective = 100 - 30 = 70
           → คน 3: 70 >= 31 → promote เป็น booked! (expires_at: 10:10:00)
           → ตั้ง Alarm ใหม่ที่ 10:06:00 (คน 2)

10:05:30 — คน 2 complete ทัน! → หัก stock + สร้าง booking
           → stock: 100 → 70

10:10:00 — ⏰ Alarm! คน 3 หมดเวลา → auto-cancel (ถ้ายังไม่ complete)
```

---

## Flow Diagram

```
POST /booking (เข้าคิว)
├── ทุก request: processExpired() — เช็คและลบ entry หมดอายุ
├── ครั้งแรก: ดึง stock จาก D1 productsPOC → เก็บใน DO Storage
├── เช็ค quantity > available_quantity → reject (stock จริงไม่พอ)
├── เช็คซ้ำ (user + product ห้ามจองซ้ำ)
├── เช็คมี waiting ก่อนหน้าไหม
│   ├── มี waiting → คนใหม่ต้อง waiting (ห้ามข้ามคิว)
│   └── ไม่มี waiting → เช็ค effective_available >= quantity
│       ├── พอ → status = "booked" + ตั้ง expires_at
│       └── ไม่พอ → status = "waiting" (expires_at = null)
├── เพิ่ม queue entry ใน DO Storage
├── ตั้ง DO Alarm (ถ้ามี booked)
└── ไม่หัก stock, ไม่สร้าง booking ใน D1

PUT /booking/:queueId/complete?product_id=X
├── processExpired() — เช็ค expired ก่อน
├── เช็คว่า status = "booked" เท่านั้น
├── หัก stock ใน DO (available_quantity -= quantity)
├── INSERT booking ใน D1 (status = 'completed')
├── UPDATE productsPOC ใน D1 (หัก stock ถาวร)
├── ลบ queue entry ออก
├── recalculate → promote waiting → booked (ตั้ง expires_at ใหม่)
└── ตั้ง DO Alarm ใหม่

PUT /booking/:queueId/cancel?product_id=X
├── processExpired() — เช็ค expired ก่อน
├── ลบ queue entry ออก (ไม่ต้องคืน stock เพราะยังไม่ได้หัก)
├── recalculateStatuses() → promote waiting → booked (ตั้ง expires_at ใหม่)
├── ตั้ง DO Alarm ใหม่
└── บันทึก queue

⏰ Alarm (auto-cancel)
├── ลบ entry ที่หมดอายุ
├── recalculate → promote waiting → booked (ตั้ง expires_at ใหม่)
└── ตั้ง Alarm ตัวถัดไป
```

### สรุป: อะไรเกิดตอนไหน

| Action | DO Stock | DO Queue | D1 bookings | D1 productsPOC | expires_at |
|---|---|---|---|---|---|
| **create-booking** | ไม่เปลี่ยน | เพิ่ม entry | ไม่ทำ | ไม่ทำ | ตั้งถ้า booked |
| **complete-booking** | **หัก** | ลบ entry + recalculate | **INSERT** (completed) | **UPDATE** (หัก stock) | ตั้งให้ promoted |
| **cancel-booking** | ไม่เปลี่ยน | ลบ entry + recalculate | ไม่ทำ | ไม่ทำ | ตั้งให้ promoted |
| **alarm (auto-cancel)** | ไม่เปลี่ยน | ลบ expired + recalculate | ไม่ทำ | ไม่ทำ | ตั้งให้ promoted |

---

## API Endpoints

Base URL: `/api/ticket-queue-test`

---

### 1. POST /api/ticket-queue-test/booking

เข้าคิวจองสินค้า (เก็บใน DO เท่านั้น ยังไม่สร้าง booking ใน D1)

**Request Body:**
```json
{
  "user_id": 1,
  "product_id": 5,
  "quantity": 40
}
```

**Response (201):**
```json
{
  "queue_entry": {
    "id": 1,
    "user_id": 1,
    "product_id": 5,
    "quantity": 40,
    "status": "booked",
    "created_at": "2026-03-19T...",
    "expires_at": "2026-03-19T10:05:00.000Z",
    "time_remaining_seconds": 300
  },
  "queue_position": 1,
  "effective_available": 60,
  "stock_available": 100,
  "message": "จองสินค้าสำเร็จ (booked)"
}
```

> ถ้า status = `waiting` → `expires_at` จะเป็น `null` และ `time_remaining_seconds` จะเป็น `null`

**Error Cases:**
| Status | เงื่อนไข |
|---|---|
| 400 | ไม่ส่ง user_id / product_id / quantity |
| 400 | quantity > available_quantity (stock จริงไม่พอ) |
| 404 | ไม่พบสินค้า |
| 409 | user มีคิวอยู่แล้วสำหรับ product นี้ |

---

### 2. PUT /api/ticket-queue-test/booking/:queueId/complete?product_id=X

Complete: หัก stock ใน DO + สร้าง booking ใน D1 + อัปเดต productsPOC

> `:queueId` คือ `queue_entry.id` ที่ได้จากตอนจอง (ไม่ใช่ bookingId เพราะ booking ยังไม่ถูกสร้าง)
> ต้อง complete ก่อน expires_at ไม่งั้นจะถูก auto-cancel

**Example:**
```
PUT /api/ticket-queue-test/booking/1/complete?product_id=5
```

**Response (200):**
```json
{
  "booking": {
    "id": 10,
    "user_id": 1,
    "product_id": 5,
    "quantity": 40,
    "status": "completed",
    "booking_date": "2026-03-19T..."
  },
  "stock_remaining": 60,
  "message": "เสร็จสิ้นการจอง หัก stock + สร้าง booking ใน D1 แล้ว"
}
```

**Error Cases:**
| Status | เงื่อนไข |
|---|---|
| 400 | ไม่ส่ง product_id query parameter |
| 400 | queue entry ไม่ใช่ status "booked" (ต้อง booked เท่านั้น) |
| 404 | ไม่พบ queue_id (อาจถูก auto-cancel แล้ว) |

---

### 3. PUT /api/ticket-queue-test/booking/:queueId/cancel?product_id=X

Cancel: ลบออกจากคิว + recalculate (promote waiting → booked ถ้า stock พอ)

> cancel ได้ทั้ง booked และ waiting

**Example:**
```
PUT /api/ticket-queue-test/booking/1/cancel?product_id=5
```

**Response (200):**
```json
{
  "message": "ยกเลิกคิวสำเร็จ",
  "cancelled_entry": {
    "id": 1,
    "user_id": 1,
    "product_id": 5,
    "quantity": 40,
    "status": "booked",
    "expires_at": "2026-03-19T10:05:00.000Z"
  },
  "stock_available": 100,
  "effective_available": 70
}
```

**Error Cases:**
| Status | เงื่อนไข |
|---|---|
| 400 | ไม่ส่ง product_id query parameter |
| 404 | ไม่พบ queue_id |

---

### 4. GET /api/ticket-queue-test/status?product_id=X&user_id=Y

เช็คสถานะคิวของ user ใน product (JOIN ข้อมูล user จาก D1)

**Example:**
```
GET /api/ticket-queue-test/status?product_id=5&user_id=1
```

**Response (200) — กรณี booked:**
```json
{
  "queue_entry": {
    "id": 1,
    "user_id": 1,
    "product_id": 5,
    "quantity": 40,
    "status": "booked",
    "created_at": "...",
    "expires_at": "2026-03-19T10:05:00.000Z",
    "time_remaining_seconds": 180
  },
  "user": {
    "id": 1,
    "first_name": "สมชาย",
    "last_name": "ใจดี",
    "email": "somchai@example.com"
  },
  "position": 1,
  "total_in_queue": 4,
  "waiting_ahead": 0,
  "booked_ahead": 0,
  "stock_available": 100,
  "stock_when_my_turn": 100,
  "can_book": true,
  "effective_available": 30
}
```

**Response (200) — กรณี waiting:**
```json
{
  "queue_entry": {
    "id": 3,
    "user_id": 3,
    "product_id": 5,
    "quantity": 31,
    "status": "waiting",
    "created_at": "...",
    "expires_at": null,
    "time_remaining_seconds": null
  },
  "user": { "id": 3, "first_name": "สมศรี", "last_name": "ใจดี", "email": "..." },
  "position": 3,
  "total_in_queue": 4,
  "waiting_ahead": 0,
  "booked_ahead": 2,
  "stock_available": 100,
  "stock_when_my_turn": 100,
  "can_book": true,
  "effective_available": 30
}
```

**ความหมายของ field:**

| Field | ความหมาย |
|---|---|
| `position` | ลำดับคิวของฉัน (1-based) |
| `waiting_ahead` | จำนวนคิว waiting ก่อนหน้าฉัน (รออีกกี่คิว) |
| `booked_ahead` | จำนวนคน booked ก่อนหน้า (รอ complete) |
| `stock_available` | stock จริงที่เหลือ (หักเฉพาะ completed) |
| `stock_when_my_turn` | stock ที่จะเหลือเมื่อถึงคิวฉัน (หลัง waiting ก่อนหน้าได้จองไป) |
| `can_book` | ถ้าถึงคิวฉัน stock พอจองไหม |
| `effective_available` | stock ว่างตอนนี้ = available_quantity - sum(booked) |
| `time_remaining_seconds` | เวลาที่เหลือก่อนหมดอายุ (วินาที) — booked เท่านั้น |

---

### 5. GET /api/ticket-queue-test/queue?product_id=X

ดู queue ทั้งหมดของ product เดียว (JOIN ข้อมูล user)

**Example:**
```
GET /api/ticket-queue-test/queue?product_id=5
```

**Response (200):**
```json
{
  "queue": [
    {
      "id": 1,
      "user_id": 1,
      "product_id": 5,
      "quantity": 40,
      "status": "booked",
      "created_at": "...",
      "expires_at": "2026-03-19T10:05:00.000Z",
      "time_remaining_seconds": 180,
      "user": { "id": 1, "first_name": "สมชาย", "last_name": "ใจดี", "email": "..." }
    },
    {
      "id": 3,
      "user_id": 3,
      "product_id": 5,
      "quantity": 31,
      "status": "waiting",
      "created_at": "...",
      "expires_at": null,
      "time_remaining_seconds": null,
      "user": { "id": 3, "first_name": "สมศรี", "last_name": "ใจดี", "email": "..." }
    }
  ],
  "total": 2,
  "booked_count": 1,
  "waiting_count": 1,
  "stock": {
    "product_id": 5,
    "product_name": "สินค้า A",
    "description": "รายละเอียด...",
    "price": 199.0,
    "total_quantity": 100,
    "available_quantity": 100
  },
  "effective_available": 60
}
```

---

### 6. GET /api/ticket-queue-test/stock?product_id=X

ดู stock + queue detail + blocked_at + เวลาที่เหลือ

**Example:**
```
GET /api/ticket-queue-test/stock?product_id=5
```

**Response (200):**
```json
{
  "stock": {
    "product_id": 5,
    "product_name": "สินค้า A",
    "description": "รายละเอียด...",
    "price": 199.0,
    "total_quantity": 100,
    "available_quantity": 100
  },
  "booked_count": 2,
  "waiting_count": 2,
  "booked_quantity": 70,
  "effective_available": 30,
  "booking_timeout_minutes": 5,
  "blocked_at": {
    "queue_id": 3,
    "user_id": 3,
    "position": 3,
    "quantity": 31,
    "effective_available": 30,
    "short": 1,
    "reason": "คิวค้างที่ตำแหน่ง 3 (queue_id: 3) — ต้องการ 31 แต่เหลือว่าง 30 (ขาดอีก 1)"
  },
  "queue": [
    {
      "id": 1, "user_id": 2, "quantity": 30, "status": "booked",
      "expires_at": "2026-03-19T10:05:00.000Z",
      "time_remaining_seconds": 180,
      "reason": "stock เพียงพอ รอ complete"
    },
    {
      "id": 2, "user_id": 1, "quantity": 40, "status": "booked",
      "expires_at": "2026-03-19T10:06:00.000Z",
      "time_remaining_seconds": 240,
      "reason": "stock เพียงพอ รอ complete"
    },
    {
      "id": 3, "user_id": 3, "quantity": 31, "status": "waiting",
      "expires_at": null,
      "time_remaining_seconds": null,
      "need": 31, "available": 30, "short": 1,
      "reason": "stock ไม่พอ ต้องการ 31 แต่เหลือว่าง 30 (ขาดอีก 1)"
    },
    {
      "id": 4, "user_id": 4, "quantity": 10, "status": "waiting",
      "expires_at": null,
      "time_remaining_seconds": null,
      "waiting_ahead": 1,
      "reason": "รอคิวก่อนหน้าอีก 1 คิว"
    }
  ]
}
```

**`blocked_at` fields:**

| Field | ความหมาย |
|---|---|
| `queue_id` | queue entry ที่ทำให้คิวค้าง |
| `position` | ตำแหน่งที่ค้าง |
| `quantity` | จำนวนที่ต้องการ |
| `effective_available` | stock ที่เหลือว่าง |
| `short` | ขาดอีกเท่าไหร่ |
| `reason` | สรุปเป็นภาษาคน |

**`queue[].reason` แต่ละ status:**

| status | reason |
|---|---|
| booked | "stock เพียงพอ รอ complete" |
| waiting (stock ไม่พอ) | "stock ไม่พอ ต้องการ X แต่เหลือว่าง Y (ขาดอีก Z)" |
| waiting (รอคิว) | "รอคิวก่อนหน้าอีก N คิว" |

---

### 7. GET /api/ticket-queue-test/queue/user?user_id=Y

ดู queue ของ user ข้ามทุก product

**Example:**
```
GET /api/ticket-queue-test/queue/user?user_id=4
```

**Response (200):**
```json
{
  "user": {
    "id": 4,
    "first_name": "สมศักดิ์",
    "last_name": "ใจดี",
    "email": "somsak@example.com"
  },
  "total_products": 2,
  "data": [
    {
      "product_id": 5,
      "stock": {
        "product_name": "สินค้า A",
        "price": 199.0,
        "available_quantity": 100
      },
      "effective_available": 20,
      "queue_entries": [
        {
          "id": 4, "user_id": 4, "quantity": 10, "status": "waiting",
          "created_at": "...", "expires_at": null, "time_remaining_seconds": null
        }
      ]
    },
    {
      "product_id": 8,
      "stock": {
        "product_name": "สินค้า B",
        "price": 350.0,
        "available_quantity": 50
      },
      "effective_available": 50,
      "queue_entries": [
        {
          "id": 1, "user_id": 4, "quantity": 20, "status": "booked",
          "created_at": "...", "expires_at": "2026-03-19T10:05:00.000Z",
          "time_remaining_seconds": 120
        }
      ]
    }
  ]
}
```

---

### 8. GET /api/ticket-queue-test/queue-all

ดู queue ทุก product (เฉพาะ product ที่มีคิว)

**Example:**
```
GET /api/ticket-queue-test/queue-all
```

**Response (200):**
```json
{
  "products_with_queue": 2,
  "data": [
    {
      "product_id": 5,
      "queue": [
        {
          "id": 1, "user_id": 1, "quantity": 40, "status": "booked",
          "expires_at": "2026-03-19T10:05:00.000Z",
          "time_remaining_seconds": 180,
          "user": {...}
        },
        {
          "id": 3, "user_id": 3, "quantity": 31, "status": "waiting",
          "expires_at": null,
          "time_remaining_seconds": null,
          "user": {...}
        }
      ],
      "total": 2,
      "booked_count": 1,
      "waiting_count": 1,
      "stock": { "product_name": "สินค้า A", "price": 199.0, "available_quantity": 100 },
      "effective_available": 60
    },
    {
      "product_id": 8,
      "queue": [...],
      "total": 3,
      "stock": { "product_name": "สินค้า B", ... }
    }
  ]
}
```

---

## Scenario: จอง 4 คน (stock = 100) + Expiration

### Step 1: คน 1-4 จอง

```
POST /booking { user_id: 1, product_id: 5, quantity: 40 }  → booked  (effective: 60, expires_at: +5min)
POST /booking { user_id: 2, product_id: 5, quantity: 30 }  → booked  (effective: 30, expires_at: +5min)
POST /booking { user_id: 3, product_id: 5, quantity: 31 }  → waiting (30 < 31 stock ไม่พอ, expires_at: null)
POST /booking { user_id: 4, product_id: 5, quantity: 9  }  → waiting (มี waiting ก่อนหน้า, expires_at: null)
```

### Step 2: คน 1 ดู status → เห็นเวลาที่เหลือ

```
GET /status?product_id=5&user_id=1
→ time_remaining_seconds: 250 (เหลือ ~4 นาที)
→ "ต้อง complete ก่อนหมดเวลา!"
```

### Step 3: คน 1 complete ทัน

```
PUT /booking/1/complete?product_id=5
→ stock: 100 → 60 (หัก 40)
→ booking สร้างใน D1 ✅
```

### Step 4: คน 2 ไม่ complete → หมดเวลา (auto-cancel)

```
⏰ Alarm ทำงาน!
→ ลบคน 2 ออกจากคิว
→ recalculate: effective = 60 - 0 = 60
→ คน 3: 60 >= 31 → promote เป็น booked! (expires_at: +5min)
→ คน 4: 60-31=29 >= 9 → ❌ ข้ามไม่ได้ เพราะ...
  → จริงๆ ได้! เพราะ recalculate วน promote ตามลำดับ
  → effective = 29 >= 9 → promote เป็น booked! (expires_at: +5min)
```

### Step 5: คน 3 cancel → คน 4 เหลือเป็น booked อยู่แล้ว

```
PUT /booking/3/cancel?product_id=5
→ ลบคน 3 → queue: คน 4(booked,9)
→ effective = 60 - 9 = 51
```

---

## API Summary

| Method | Endpoint | Description |
|---|---|---|
| POST | `/booking` | เข้าคิวจอง |
| PUT | `/booking/:queueId/complete?product_id=X` | complete → หัก stock + สร้าง booking D1 |
| PUT | `/booking/:queueId/cancel?product_id=X` | cancel → ลบคิว + promote waiting |
| GET | `/status?product_id=X&user_id=Y` | สถานะคิวของ user ใน product |
| GET | `/queue?product_id=X` | คิวทั้งหมดของ product (JOIN user) |
| GET | `/stock?product_id=X` | stock + queue detail + blocked_at + เวลาที่เหลือ |
| GET | `/queue/user?user_id=Y` | คิวของ user ข้ามทุก product |
| GET | `/queue-all` | คิวทุก product |

---

## Configuration

| ค่า | Default | อธิบาย |
|---|---|---|
| `BOOKING_TIMEOUT_MS` | `5 * 60 * 1000` (5 นาที) | เวลาหมดอายุการจอง — แก้ที่ `TicketQueueDOTest.ts` บรรทัดบน |

---

## Files

| File | Description |
|---|---|
| `src/durableObjects/TicketQueueDOTest.ts` | Durable Object class — queue + stock + expiration logic |
| `src/routes/ticketQueueTest.ts` | Route handler — proxy requests ไป DO instance ตาม product_id |
| `src/pages/ticketQueueTestPage.ts` | HTML Test Page — หน้าเว็บสำหรับทดสอบ API ผ่าน browser |
| `wrangler.jsonc` | Binding: `TICKET_QUEUE_TEST` → class `TicketQueueDOTest` |
| `src/index.ts` | Export class + import route handler + serve HTML page |

---

## HTML Test Page (หน้าเว็บทดสอบ)

เปิด browser ไปที่ `http://localhost:8787/ticket-queue-test` จะได้หน้าเว็บสำหรับทดสอบ API ทั้งหมดโดยไม่ต้องใช้ Postman/cURL

### วิธีใช้งาน

```
npx wrangler dev
→ เปิด http://localhost:8787/ticket-queue-test
```

### ส่วนประกอบของหน้าเว็บ

| ส่วน | ทำอะไร | API ที่เรียก |
|---|---|---|
| **Create Booking** | กรอก user_id, product_id, quantity แล้วกด Create | `POST /api/ticket-queue-test/booking` |
| **Stock Info** | กรอก product_id แล้วกด Load ดู stock + queue detail | `GET /api/ticket-queue-test/stock?product_id=X` |
| **Queue All** | กด Load ดู queue ทุก product | `GET /api/ticket-queue-test/queue-all` |
| **Queue by User** | กรอก user_id แล้วกด Load ดู queue ของ user ข้ามทุก product | `GET /api/ticket-queue-test/queue/user?user_id=Y` |

### ปุ่ม Complete / Cancel

- ทุก queue entry ที่สถานะเป็น `booked` หรือ `waiting` จะมีปุ่ม **Complete** และ **Cancel**
- กด **Complete** → `PUT /api/ticket-queue-test/booking/:queueId/complete?product_id=X`
- กด **Cancel** → `PUT /api/ticket-queue-test/booking/:queueId/cancel?product_id=X`
- หลังกดจะ auto-refresh ข้อมูลที่แสดงอยู่ทั้งหมด

### ข้อมูลที่แสดงในตาราง Queue

| Column | มาจาก field | อธิบาย |
|---|---|---|
| Queue ID | `entry.id` | ID ของ queue entry (ใช้สำหรับ complete/cancel) |
| User | `entry.user.first_name + last_name` | ชื่อ user (JOIN จาก D1) ถ้าไม่มีแสดง user_id |
| Qty | `entry.quantity` | จำนวนที่จอง |
| Status | `entry.status` | สถานะ: `booked` (สีม่วง), `waiting` (สีเหลือง) |
| Expires At | `entry.expires_at` | เวลาหมดอายุ (เฉพาะ booked, waiting = `-`) |
| Time Remaining | `entry.time_remaining_seconds` | เวลาที่เหลือ เช่น `4m 30s`, ถ้าหมดแสดง `Expired` สีแดง |
| Actions | - | ปุ่ม Complete / Cancel (เฉพาะ booked, waiting) |

### สถานะ Badge สี

| Status | สี | CSS Class |
|---|---|---|
| `booked` | ม่วง | `.badge-booked` |
| `waiting` | เหลือง | `.badge-waiting` |
| `active` | น้ำเงิน | `.badge-active` |
| `completed` | เขียว | `.badge-completed` |
| `cancelled` | แดง | `.badge-cancelled` |
| `expired` | เทา | `.badge-expired` |

### ตัวอย่างการทดสอบ

```
1. เปิดหน้าเว็บ http://localhost:8787/ticket-queue-test

2. สร้าง Booking 4 คน:
   - user_id=1, product_id=17, quantity=40 → กด Create → ได้ booked
   - user_id=2, product_id=17, quantity=30 → กด Create → ได้ booked
   - user_id=3, product_id=17, quantity=31 → กด Create → ได้ waiting (stock ไม่พอ)
   - user_id=4, product_id=17, quantity=9  → กด Create → ได้ waiting (มี waiting ก่อนหน้า)

3. ดู Stock Info:
   - กรอก product_id=17 กด Load
   - เห็น stock, effective_available, queue detail + เวลาที่เหลือ

4. ดู Queue All:
   - กด Load Queue All → เห็นทุก product ที่มี queue

5. ทดสอบ Complete:
   - ที่ queue entry คน 1 กดปุ่ม Complete
   - stock จะถูกหัก, booking สร้างใน D1
   - ข้อมูลจะ auto-refresh

6. ทดสอบ Cancel:
   - ที่ queue entry คน 2 กดปุ่ม Cancel
   - คน 3,4 อาจถูก promote เป็น booked (ถ้า stock พอ)
   - ข้อมูลจะ auto-refresh

7. ดู Queue by User:
   - กรอก user_id=3 กด Load → เห็น queue ของ user ข้ามทุก product
```

### Technical Notes

- HTML page เป็น inline string ใน TypeScript (ไม่ใช้ static assets)
- Serve จาก route `GET /ticket-queue-test` ด้วย `Content-Type: text/html; charset=utf-8`
- ใช้ vanilla HTML + CSS + JavaScript (ไม่มี framework)
- Responsive layout (2 columns → 1 column บนมือถือ)
- `showResult()` ใช้แสดง plain text/JSON (escape HTML)
- `showHtml()` ใช้แสดง HTML ที่สร้างจาก JS (render เป็น table, badge, buttons)

---

## cURL Commands

Base URL ตัวอย่าง: `http://localhost:8787`

### 1. เข้าคิวจอง

```bash
curl -X POST http://localhost:8787/api/ticket-queue-test/booking \
  -H "Content-Type: application/json" \
  -d '{"user_id": 1, "product_id": 5, "quantity": 40}'
```

### 2. Complete

```bash
curl -X PUT "http://localhost:8787/api/ticket-queue-test/booking/1/complete?product_id=5"
```

### 3. Cancel

```bash
curl -X PUT "http://localhost:8787/api/ticket-queue-test/booking/1/cancel?product_id=5"
```

### 4. เช็คสถานะ user (ดู time_remaining_seconds)

```bash
curl "http://localhost:8787/api/ticket-queue-test/status?product_id=5&user_id=1"
```

### 5. ดู queue ของ product

```bash
curl "http://localhost:8787/api/ticket-queue-test/queue?product_id=5"
```

### 6. ดู stock + blocked_at + เวลาที่เหลือ

```bash
curl "http://localhost:8787/api/ticket-queue-test/stock?product_id=5"
```

### 7. ดู queue ของ user ข้ามทุก product

```bash
curl "http://localhost:8787/api/ticket-queue-test/queue/user?user_id=4"
```

### 8. ดู queue ทุก product

```bash
curl "http://localhost:8787/api/ticket-queue-test/queue-all"
```

### Scenario ทดสอบครบ loop + expiration

```bash
# จอง 4 คน
curl -X POST http://localhost:8787/api/ticket-queue-test/booking -H "Content-Type: application/json" -d '{"user_id":1,"product_id":5,"quantity":40}'
curl -X POST http://localhost:8787/api/ticket-queue-test/booking -H "Content-Type: application/json" -d '{"user_id":2,"product_id":5,"quantity":30}'
curl -X POST http://localhost:8787/api/ticket-queue-test/booking -H "Content-Type: application/json" -d '{"user_id":3,"product_id":5,"quantity":31}'
curl -X POST http://localhost:8787/api/ticket-queue-test/booking -H "Content-Type: application/json" -d '{"user_id":4,"product_id":5,"quantity":9}'

# ดู stock + blocked_at + เวลาที่เหลือ
curl "http://localhost:8787/api/ticket-queue-test/stock?product_id=5"

# ดูสถานะคน 1 (booked, เห็น time_remaining_seconds)
curl "http://localhost:8787/api/ticket-queue-test/status?product_id=5&user_id=1"

# ดูสถานะคน 3 (waiting, time_remaining_seconds = null)
curl "http://localhost:8787/api/ticket-queue-test/status?product_id=5&user_id=3"

# คน 1 complete ทัน
curl -X PUT "http://localhost:8787/api/ticket-queue-test/booking/1/complete?product_id=5"

# รอ 5 นาที... คน 2 ไม่ complete → auto-cancel
# ดู queue หลัง auto-cancel (คน 3,4 อาจ promote)
curl "http://localhost:8787/api/ticket-queue-test/queue?product_id=5"

# ดู stock หลัง auto-cancel
curl "http://localhost:8787/api/ticket-queue-test/stock?product_id=5"

# ดู queue ของ user 4 ข้ามทุก product
curl "http://localhost:8787/api/ticket-queue-test/queue/user?user_id=4"

# ดู queue ทุก product
curl "http://localhost:8787/api/ticket-queue-test/queue-all"
```
