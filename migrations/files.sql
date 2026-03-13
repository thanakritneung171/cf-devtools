CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- รหัสไฟล์

    file_name TEXT, -- ชื่อไฟล์
    file_path TEXT, -- path หรือ location ของไฟล์ (เช่น R2 storage)
    file_type TEXT, -- ประเภทไฟล์ เช่น image / pdf / log

    uploaded_by INTEGER, -- ผู้ใช้ที่อัปโหลดไฟล์

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- วันที่อัปโหลด

    FOREIGN KEY (uploaded_by) REFERENCES users(id) -- FK ไปยัง Users
);