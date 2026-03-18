# CF-DevTools API Documentation

## Cloudflare Services ที่ใช้

| Service | ใช้สำหรับ | Binding |
|---------|----------|---------|
| **D1** (SQLite) | productsPOC, bookings, product_queue, Logs, files, users, posts | `DB` |
| **KV** | Cache user data, token revocation | `USERS_CACHE` |
| **R2** | File/image storage | `MY_BUCKET` |
| **Vectorize + AI** | Vector search (products, productsPOC, bookings, documents) | `VECTORIZE`, `PRODUCTS_INDEX`, `PRODUCTS_POC_INDEX`, `BOOKINGS_INDEX`, `AI` |
| **Durable Object** | Product Queue (legacy, ย้ายไป service แล้ว) | `PRODUCT_QUEUE` |
| **Durable Object** | Ticket Queue (ตัวอย่างระบบจองตั๋ว) | `TICKET_QUEUE` |

---

## Authentication

ทุก API ที่ต้อง Auth ให้แนบ Header:
```
Authorization: Bearer <token>
```

### Login
```
POST /api/auth/login
Body: { "email": "...", "password_hash": "..." }
Response: { "user": {...}, "token": "...", "message": "..." }
```

### Logout
```
POST /api/auth/logout
Header: Authorization: Bearer <token>
```

---

## ProductPOC API (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/productPOC` | สร้างสินค้า + สร้าง Vectorize embedding |
| GET | `/api/productPOC?page=1&limit=10&search=keyword` | ดูสินค้าทั้งหมด (pagination + search) |
| GET | `/api/productPOC/:id` | ดูสินค้าตาม ID |
| PUT | `/api/productPOC/:id` | แก้ไขสินค้า + อัปเดต Vectorize embedding |
| DELETE | `/api/productPOC/:id` | ลบสินค้า + ลบ Vectorize vector |
| GET | `/api/productPOC/search?q=keyword&topK=5` | Semantic search + ข้อมูลจาก D1 |
| GET | `/api/productPOC/search/fast?q=keyword&topK=5` | Semantic search (metadata only, เร็วกว่า) |

---

## Bookings API (Auth Required)

### การจอง (Bookings)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bookings` | จองสินค้า (สร้าง booking + product_queue อัตโนมัติ) |
| GET | `/api/bookings?page=1&limit=10` | ดูการจองทั้งหมด |
| GET | `/api/bookings/:id` | ดูการจองตาม ID (พร้อม product_queue ที่เชื่อม) |
| GET | `/api/bookings/user/:userId` | ดูการจองของ user |
| GET | `/api/bookings/product/:productId` | ดูการจองของสินค้า |
| PUT | `/api/bookings/:id/complete` | เสร็จสิ้น (ไม่คืน stock, product_queue → completed, promote WAITING) |
| PUT | `/api/bookings/:id/cancel` | ยกเลิก (คืน stock, ลบ product_queue, promote WAITING) |
| GET | `/api/bookings/search?q=keyword&topK=5` | Semantic search + ข้อมูลจาก D1 |
| GET | `/api/bookings/search/fast?q=keyword&topK=5` | Semantic search (metadata only, เร็วกว่า) |

#### POST /api/bookings — สร้างการจอง
```json
Body: { "user_id": 1, "product_id": 2, "quantity": 1 }
Response (201): {
  "booking": { "id": 1, "status": "booked", ... },
  "queue_status": "ACTIVE",
  "queue_position": 1,
  "message": "จองสินค้าสำเร็จ (ACTIVE)"
}
```

**เงื่อนไขสำคัญ (เช็คตามลำดับก่อนสร้าง booking):**
1. ตรวจสอบสินค้า — ถ้าไม่พบ product → error
2. ตรวจสอบ `total_quantity` — จองเกินไม่ได้
3. ตรวจสอบ `available_quantity` — stock ไม่พอ → error
4. **ตรวจสอบคิวซ้ำ** — ถ้า user มีคิว ACTIVE/WAITING อยู่แล้วใน product เดียวกัน → error (ไม่สร้าง booking, ไม่หัก stock)
5. ถ้าผ่านทั้งหมด → สร้าง booking + หัก stock + เพิ่ม product_queue
- ถ้า product_id มี ACTIVE < 2 คน → `booking.status = booked`, `product_queue.status = ACTIVE`
- ถ้า product_id มี ACTIVE >= 2 คน → `booking.status = WAITING`, `product_queue.status = WAITING`

#### PUT /api/bookings/:id/complete — เสร็จสิ้นการจอง
- booking.status → `completed`
- **ลบ product_queue record** ของ booking นั้น
- **ไม่คืน available_quantity** (stock ถูกใช้ไปแล้ว)
- promote คิว WAITING ถัดไป → ACTIVE (booking ของเขาเปลี่ยนเป็น `booked`)

#### PUT /api/bookings/:id/cancel — ยกเลิกการจอง
- booking.status → `cancelled`
- **คืน available_quantity** (stock กลับมา)
- **ลบ product_queue record** ของ booking นั้น
- promote คิว WAITING ถัดไป → ACTIVE (booking ของเขาเปลี่ยนเป็น `booked`)

### Booking Flow
1. เช็คสินค้า → เช็ค quantity → **เช็คคิวซ้ำก่อน** (ถ้าซ้ำ throw error ไม่สร้าง booking ไม่หัก stock)
2. สร้าง booking + หัก stock + เพิ่ม product_queue ด้วย booking_id
3. ถ้า ACTIVE < 2 → status `booked` + `ACTIVE` (จองได้เลย)
4. ถ้า ACTIVE >= 2 → status `WAITING` + `WAITING` (รอคิว)
5. Complete → ไม่คืน stock, ลบ product_queue, promote WAITING ถัดไปเป็น ACTIVE
6. Cancel → คืน stock, ลบ product_queue, promote WAITING ถัดไปเป็น ACTIVE

### ข้อจำกัด
- ผู้ใช้แต่ละคนจองสินค้าเดียวกันได้แค่ 1 ครั้ง (ถ้ามีคิว ACTIVE/WAITING อยู่แล้วจะไม่สามารถจองซ้ำได้)
- ACTIVE สูงสุด 2 คนต่อ product_id

---

## Product Queue API (Auth Required)

> ย้ายจาก Durable Object `/queue/*` มาเป็น routes/services structure แบบเดียวกับ API อื่น
> ใช้ logic เดียวกับ `ProductQueueDO.ts` เป๊ะ (join, status, leave)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/product-queue/join` | เข้าคิว (เหมือน DO `/join`) |
| GET | `/api/product-queue/status?productId=...&userId=...` | ดูสถานะคิว (เหมือน DO `/queue/status`) |
| POST | `/api/product-queue/leave` | ออกจากคิว DELETE + promote (เหมือน DO `/leave`) |

#### POST /api/product-queue/join
```json
Body: { "userId": 1, "productId": 2, "bookingId": 5 }
Response: { "status": "ACTIVE", "position": 1 }
```
- ถ้า ACTIVE < 2 → status = `ACTIVE`
- ถ้า ACTIVE >= 2 → status = `WAITING`
- `bookingId` optional (ใช้เชื่อมกับ bookings)

#### GET /api/product-queue/status
```json
Query: ?productId=2&userId=1
Response: {
  "inQueue": true,
  "position": 2,
  "peopleAhead": 1,
  "total": 5
}
```

#### POST /api/product-queue/leave
```json
Body: { "userId": 1, "productId": 2 }
Response: { "message": "left queue" }
```
- DELETE record ของ user จากคิว
- ถ้า ACTIVE < 2 → promote WAITING ถัดไปเป็น ACTIVE

---

## Ticket Queue API — Durable Object (No Auth)

> ตัวอย่างระบบจองตั๋วที่ใช้ Durable Object (`TicketQueueDO`) เพื่อ single-threaded per product
> ใช้ตาราง `ticket_queue` (schema เหมือน `product_queue` แต่แยกตาราง)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ticket-queue/join` | เข้าคิว (เช็คซ้ำ + รับ bookingId) |
| GET | `/api/ticket-queue/status?productId=...&userId=...` | ดูสถานะคิว |
| POST | `/api/ticket-queue/leave` | ออกจากคิว (DELETE + promote) |
| POST | `/api/ticket-queue/leave-completed` | เสร็จแล้ว → COMPLETED + promote |
| POST | `/api/ticket-queue/leave-cancelled` | ยกเลิก → CANCELLED + promote |
| GET | `/api/ticket-queue/active-count?productId=...` | นับจำนวน ACTIVE |

#### POST /api/ticket-queue/join
```json
Body: { "userId": 1, "productId": 2, "bookingId": 5 }
Response: { "queueId": 10, "status": "ACTIVE", "position": 1, "bookingId": 5 }
```
- ห้ามจองซ้ำ (ถ้ามี ACTIVE/WAITING อยู่แล้ว → 409)
- `bookingId` optional
- ถ้า ACTIVE < 2 → status = `ACTIVE`, ถ้า >= 2 → `WAITING`

#### GET /api/ticket-queue/status
```json
Query: ?productId=2&userId=1
Response: { "inQueue": true, "position": 2, "peopleAhead": 1, "total": 5 }
```

#### POST /api/ticket-queue/leave
```json
Body: { "userId": 1, "productId": 2 }
Response: { "message": "left queue" }
```

#### POST /api/ticket-queue/leave-completed
```json
Body: { "userId": 1, "productId": 2 }
Response: { "message": "completed" }
```
- เปลี่ยน status เป็น `COMPLETED` + promote WAITING ถัดไป

#### POST /api/ticket-queue/leave-cancelled
```json
Body: { "userId": 1, "productId": 2 }
Response: { "message": "cancelled" }
```
- เปลี่ยน status เป็น `CANCELLED` + promote WAITING ถัดไป

#### GET /api/ticket-queue/active-count
```json
Query: ?productId=2
Response: { "activeCount": 1, "limit": 2 }
```

### Flow
```
POST /api/ticket-queue/join
  → ticketQueue.ts route
  → env.TICKET_QUEUE.idFromName(productId)
  → stub.fetch("/join")
  → TicketQueueDO (single-threaded per product)
  → D1 (ticket_queue table)
```

---

## Logs API (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/logs?page=1&limit=20&log_type=request` | ดู logs (filter: log_type) |
| GET | `/api/logs/:id` | ดู log ตาม ID |
| DELETE | `/api/logs/:id` | ลบ log |

### Log Types
- `activity` - กิจกรรมทั่วไป
- `error` - ข้อผิดพลาด
- `request` - HTTP request logs (บันทึกอัตโนมัติ)

---

## Files API (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/files` | อัปโหลดไฟล์ (multipart/form-data, field: `file`) |
| GET | `/api/files?page=1&limit=20` | ดูรายการไฟล์ |
| GET | `/api/files/:id` | ดูข้อมูลไฟล์ |
| GET | `/api/files/:id/download` | ดาวน์โหลดไฟล์จาก R2 |
| DELETE | `/api/files/:id` | ลบไฟล์ (R2 + D1) |

### Upload File
```
POST /api/files
Content-Type: multipart/form-data
Body: file=<binary>
Max size: 10MB
```

---

## Users API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/users` | No | สร้างผู้ใช้ |
| GET | `/api/users` | Yes | ดูผู้ใช้ทั้งหมด |
| GET | `/api/users/:id` | Yes | ดูผู้ใช้ตาม ID |
| PUT | `/api/users/:id` | Yes | แก้ไขผู้ใช้ |
| POST | `/api/users/:id/avatar` | No | อัปโหลด avatar |
| DELETE | `/api/users/:id` | Yes | ลบผู้ใช้ (soft delete) |

---

## Database Schema

### productsPOC
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | รหัสสินค้า |
| user_id | INTEGER FK | ผู้สร้างสินค้า |
| product_name | TEXT | ชื่อสินค้า |
| description | TEXT | รายละเอียด |
| price | REAL | ราคา |
| total_quantity | INTEGER | จำนวนทั้งหมด (สูงสุดที่จองได้) |
| available_quantity | INTEGER | จำนวนที่ว่าง (ลดเมื่อจอง, คืนเมื่อ cancel) |
| created_at | DATETIME | วันที่สร้าง |
| updated_at | DATETIME | วันที่แก้ไข |

### bookings
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | รหัสการจอง |
| user_id | INTEGER FK | ผู้จอง |
| product_id | INTEGER FK | สินค้าที่จอง |
| quantity | INTEGER | จำนวน |
| status | TEXT | booked / WAITING / cancelled / completed |
| booking_date | DATETIME | วันที่จอง |

### product_queue
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK AUTOINCREMENT | รหัสคิว |
| product_id | INTEGER NOT NULL | สินค้า |
| user_id | INTEGER NOT NULL | ผู้ใช้ |
| booking_id | INTEGER FK | เชื่อมกับ bookings.id |
| status | TEXT DEFAULT 'WAITING' | ACTIVE / WAITING |
| created_at | TEXT DEFAULT CURRENT_TIMESTAMP | วันที่เข้าคิว |

**กฎ:**
- ACTIVE สูงสุด 2 คนต่อ product_id
- เมื่อมีคน leave (complete/cancel) → promote WAITING ถัดไปเป็น ACTIVE
- ผู้ใช้แต่ละคนมีคิว ACTIVE/WAITING ได้แค่ 1 รายการต่อ product_id (ป้องกันจองซ้ำ)

**Indexes:**
- `idx_product_queue_booking` — booking_id
- `idx_product_queue_status` — product_id, status
- `idx_product_queue_user` — product_id, user_id

### ticket_queue
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK AUTOINCREMENT | รหัสคิว |
| product_id | INTEGER NOT NULL | สินค้า |
| user_id | INTEGER NOT NULL | ผู้ใช้ |
| booking_id | INTEGER | เชื่อมกับ bookings.id (optional) |
| status | TEXT DEFAULT 'WAITING' | ACTIVE / WAITING / COMPLETED / CANCELLED |
| created_at | TEXT DEFAULT CURRENT_TIMESTAMP | วันที่เข้าคิว |

**กฎ:**
- ACTIVE สูงสุด 2 คนต่อ product_id
- เมื่อ leave-completed/leave-cancelled → promote WAITING ถัดไปเป็น ACTIVE
- ผู้ใช้แต่ละคนมีคิว ACTIVE/WAITING ได้แค่ 1 รายการต่อ product_id (ป้องกันจองซ้ำ)

**Indexes:**
- `idx_ticket_queue_status` — product_id, status
- `idx_ticket_queue_user` — product_id, user_id

### Logs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | รหัส log |
| log_type | TEXT | activity / error / request |
| http_status | INTEGER | HTTP status code |
| url | TEXT | URL ที่ถูกเรียก |
| description | TEXT | รายละเอียด |
| created_at | DATETIME | เวลาที่เกิด |

### files
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | รหัสไฟล์ |
| file_name | TEXT | ชื่อไฟล์ |
| file_path | TEXT | path ใน R2 |
| file_type | TEXT | image / pdf / text / other |
| uploaded_by | INTEGER FK | ผู้อัปโหลด |
| created_at | DATETIME | วันที่อัปโหลด |
