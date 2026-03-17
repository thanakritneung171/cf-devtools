-- เพิ่มคอลัมน์สำหรับระบบ countdown simulation
ALTER TABLE bookings ADD COLUMN estimated_complete_at DATETIME; -- เวลาที่คาดว่าจะเสร็จ (ใช้สำหรับ countdown)
ALTER TABLE bookings ADD COLUMN countdown_seconds INTEGER; -- จำนวนวินาทีถอยหลังที่ random ได้
