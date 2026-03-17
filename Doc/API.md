# CF-DevTools API Documentation

## Cloudflare Services ที่ใช้

| Service | ใช้สำหรับ | Binding |
|---------|----------|---------|
| **D1** (SQLite) | productsPOC, bookings, bookingQueue, Logs, files, users, posts | `DB` |
| **KV** | Cache user data, token revocation | `USERS_CACHE` |
| **R2** | File/image storage | `MY_BUCKET` |
| **Vectorize + AI** | Vector search (products, productsPOC, bookings, documents) | `VECTORIZE`, `PRODUCTS_INDEX`, `PRODUCTS_POC_INDEX`, `BOOKINGS_INDEX`, `AI` |
| **Queue** | Async image resize | `IMAGE_RESIZE_QUEUE` |

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
| POST | `/api/bookings` | จองสินค้า (auto queue ถ้าเกิน) + สร้าง Vectorize embedding |
| GET | `/api/bookings?page=1&limit=10` | ดูการจองทั้งหมด |
| GET | `/api/bookings/:id` | ดูการจองตาม ID |
| GET | `/api/bookings/user/:userId` | ดูการจองของ user |
| GET | `/api/bookings/product/:productId` | ดูการจองของสินค้า |
| PUT | `/api/bookings/:id/complete` | เสร็จสิ้นการจอง (คืน stock + process queue) + ลบ Vectorize vector |
| PUT | `/api/bookings/:id/cancel` | ยกเลิกการจอง (คืน stock + process queue) + ลบ Vectorize vector |
| GET | `/api/bookings/search?q=keyword&topK=5` | Semantic search + ข้อมูลจาก D1 |
| GET | `/api/bookings/search/fast?q=keyword&topK=5` | Semantic search (metadata only, เร็วกว่า) |

### Countdown Simulation (จำลองนับถอยหลัง)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bookings/:id/start-countdown` | เริ่มนับถอยหลังแบบ random (auto-complete เมื่อหมดเวลา) |
| GET | `/api/bookings/:id/countdown` | ดูสถานะ countdown (ถ้าหมดเวลา auto-complete ทันที) |

#### POST /api/bookings/:id/start-countdown
```json
Body (optional): { "min_seconds": 10, "max_seconds": 120 }
Response: {
  "countdown": {
    "booking_id": 1,
    "status": "counting_down",
    "countdown_seconds": 45,
    "estimated_complete_at": "2026-03-16T10:00:45.000Z",
    "remaining_seconds": 45,
    "is_completed": false
  },
  "message": "เริ่มนับถอยหลัง 45 วินาที เมื่อหมดเวลาจะ complete อัตโนมัติ"
}
```

#### GET /api/bookings/:id/countdown
```json
Response (กำลังนับ): {
  "countdown": { "remaining_seconds": 20, "is_completed": false, ... },
  "message": "เหลือเวลาอีก 20 วินาที"
}
Response (หมดเวลา - auto complete): {
  "countdown": { "remaining_seconds": 0, "is_completed": true, ... },
  "message": "หมดเวลาแล้ว! การจองเสร็จสิ้น คิวถัดไปได้รับการประมวลผลแล้ว"
}
```

### คิว (Queue Management)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bookings/queue?page=1&limit=10&status=waiting` | ดู bookingQueue ทั้งหมด (filter ด้วย status ได้) |
| GET | `/api/bookings/queue/:productId` | ดูคิวทั้งหมดของสินค้า |
| GET | `/api/bookings/queue/:productId/count` | นับจำนวนคิวที่รอ |
| GET | `/api/bookings/queue/position/:queueId` | ดูตำแหน่งคิว (ลำดับที่เท่าไหร่) |
| POST | `/api/bookings/from-queue/:queueId` | สร้าง booking จาก bookingQueue ID (หยิบคนจากคิวมาจองจริง) |
| PUT | `/api/bookings/queue/:id/cancel` | ยกเลิกคิว |
| DELETE | `/api/bookings/queue/:productId/clear` | เคลียร์คิวทั้งหมดของสินค้า |

#### GET /api/bookings/queue — ดึง bookingQueue ทั้งหมด
```
GET /api/bookings/queue?page=1&limit=10&status=waiting
Query params:
  - page (default: 1)
  - limit (default: 10)
  - status (optional): waiting / completed / cancelled — ถ้าไม่ระบุจะดึงทั้งหมด
Response: {
  "data": [ { "id": 1, "user_id": 2, "product_id": 3, "quantity": 5, "queue_number": 1, "status": "waiting", "created_at": "..." } ],
  "pagination": { "page": 1, "limit": 10, "total": 25, "total_pages": 3 }
}
```

#### POST /api/bookings/from-queue/:queueId — สร้าง booking จากคิว
```
POST /api/bookings/from-queue/5
Response (201): {
  "booking": { "id": 10, "user_id": 2, "product_id": 3, "quantity": 5, "status": "booked", ... },
  "queue": { "id": 5, "status": "completed", ... },
  "message": "สร้างการจองจากคิว #5 สำเร็จ"
}
```
- เช็ค stock ก่อนจอง ถ้าไม่พอจะ error
- อัปเดต queue status เป็น `completed`
- ลด `available_quantity` ของสินค้า
- สร้าง Vectorize embedding ให้ booking ใหม่

### Booking Flow
1. ถ้า `available_quantity >= quantity` → จองสำเร็จ, ลด stock, สร้าง Vectorize embedding
2. ถ้า `available_quantity < quantity` → เข้า Queue อัตโนมัติ (ไม่สร้าง embedding)
3. เมื่อยกเลิกการจอง → คืน stock + process Queue + ลบ Vectorize vector
4. เมื่อ complete การจอง → คืน stock + process Queue ให้คิวถัดไปจองได้อัตโนมัติ
5. ใช้ countdown simulation → random เวลาถอยหลัง เมื่อหมดเวลา auto-complete แล้วคิวถัดไปเข้ามาได้
6. ใช้ `from-queue` → หยิบคนจากคิวมาสร้าง booking ด้วยตัวเอง (manual)

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
| total_quantity | INTEGER | จำนวนทั้งหมด |
| available_quantity | INTEGER | จำนวนที่เหลือ |
| created_at | DATETIME | วันที่สร้าง |
| updated_at | DATETIME | วันที่แก้ไข |

### bookings
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | รหัสการจอง |
| user_id | INTEGER FK | ผู้จอง |
| product_id | INTEGER FK | สินค้าที่จอง |
| quantity | INTEGER | จำนวน |
| status | TEXT | booked / cancelled / completed |
| booking_date | DATETIME | วันที่จอง |
| estimated_complete_at | DATETIME | เวลาที่คาดว่าจะเสร็จ (countdown) |
| countdown_seconds | INTEGER | จำนวนวินาทีถอยหลังที่ random ได้ |

### bookingQueue
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | รหัสคิว |
| user_id | INTEGER FK | ผู้ใช้ในคิว |
| product_id | INTEGER FK | สินค้า |
| quantity | INTEGER | จำนวนที่ต้องการ |
| queue_number | INTEGER | ลำดับคิว |
| status | TEXT | waiting / completed / cancelled |
| created_at | DATETIME | วันที่เข้าคิว |

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
