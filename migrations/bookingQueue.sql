CREATE TABLE bookingQueue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- รหัสคิว

    user_id INTEGER NOT NULL, -- ผู้ใช้ที่อยู่ในคิว
    product_id INTEGER NOT NULL, -- สินค้าที่ต้องการจอง

    quantity INTEGER NOT NULL, -- จำนวนที่ต้องการจอง

    queue_number INTEGER NOT NULL, -- ลำดับคิว

    status TEXT DEFAULT 'waiting', -- สถานะคิว เช่น waiting / completed / cancelled

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- วันที่เข้าคิว

    FOREIGN KEY (user_id) REFERENCES users(id), -- FK ไปยัง Users
    FOREIGN KEY (product_id) REFERENCES productsPOC(id) -- FK ไปยัง Products
);