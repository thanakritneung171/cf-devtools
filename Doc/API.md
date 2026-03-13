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

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bookings` | จองสินค้า (auto queue ถ้าเกิน) + สร้าง Vectorize embedding |
| GET | `/api/bookings?page=1&limit=10` | ดูการจองทั้งหมด |
| GET | `/api/bookings/user/:userId` | ดูการจองของ user |
| GET | `/api/bookings/product/:productId` | ดูการจองของสินค้า |
| PUT | `/api/bookings/:id/cancel` | ยกเลิกการจอง (คืน stock + process queue) + ลบ Vectorize vector |
| GET | `/api/bookings/queue/:productId` | ดูคิวของสินค้า |
| PUT | `/api/bookings/queue/:id/cancel` | ยกเลิกคิว |
| GET | `/api/bookings/search?q=keyword&topK=5` | Semantic search + ข้อมูลจาก D1 |
| GET | `/api/bookings/search/fast?q=keyword&topK=5` | Semantic search (metadata only, เร็วกว่า) |
```

### Booking Flow
1. ถ้า `available_quantity >= quantity` → จองสำเร็จ, ลด stock, สร้าง Vectorize embedding
2. ถ้า `available_quantity < quantity` → เข้า Queue อัตโนมัติ (ไม่สร้าง embedding)
3. เมื่อยกเลิกการจอง → คืน stock + process Queue + ลบ Vectorize vector

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
