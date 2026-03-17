CREATE TABLE Logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- รหัส log
    log_type TEXT, -- ประเภท log เช่น activity / error / request
    http_status INTEGER, -- HTTP Status code เช่น 200 404 500
    url TEXT, -- URL ที่ถูกเรียก
    description TEXT, -- รายละเอียดของ log
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP -- เวลาที่เกิด log
);