CREATE TABLE productsPOC (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- รหัสสินค้า
    user_id INTEGER NOT NULL, -- ผู้ใช้ที่ทำการจอง
    product_name TEXT NOT NULL, -- ชื่อสินค้า
    description TEXT, -- รายละเอียดสินค้า
    price REAL NOT NULL, -- ราคาสินค้า
    total_quantity INTEGER NOT NULL, -- จำนวนสินค้าทั้งหมดที่มี
    available_quantity INTEGER NOT NULL, -- จำนวนสินค้าที่เหลือให้จอง
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- วันที่สร้างสินค้า
    updated_at DATETIME, -- วันที่แก้ไขข้อมูลล่าสุด
    FOREIGN KEY (user_id) REFERENCES users(id) -- FK ไปยัง Users
);