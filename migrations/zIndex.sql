CREATE INDEX idx_product_name 
ON productsPOC(product_name); -- index สำหรับ search ชื่อสินค้า

CREATE INDEX idx_booking_user 
ON bookings(user_id); -- index สำหรับ query การจองของ user

CREATE INDEX idx_queue_product 
ON bookingQueue(product_id); -- index สำหรับค้นหาคิวของสินค้า

CREATE INDEX idx_logs_type 
ON logs(log_type); -- index สำหรับ filter log ตามประเภท