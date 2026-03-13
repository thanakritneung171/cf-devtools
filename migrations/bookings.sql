CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- รหัสการจอง

    user_id INTEGER NOT NULL, -- ผู้ใช้ที่ทำการจอง
    product_id INTEGER NOT NULL, -- สินค้าที่ถูกจอง

    quantity INTEGER NOT NULL, -- จำนวนสินค้าที่จอง
    status TEXT DEFAULT 'booked', -- สถานะการจอง เช่น booked / cancelled / completed

    booking_date DATETIME DEFAULT CURRENT_TIMESTAMP, -- วันที่ทำการจอง

    FOREIGN KEY (user_id) REFERENCES users(id), -- FK ไปยัง Users
    FOREIGN KEY (product_id) REFERENCES productsPOC(id) -- FK ไปยัง Products
);