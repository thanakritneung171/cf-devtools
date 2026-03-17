// === ProductPOC ===
export interface ProductPOC {
  id: number;
  user_id: number;
  product_name: string;
  description?: string;
  price: number;
  total_quantity: number;
  available_quantity: number;
  image_id?: number;
  image_url?: string;
  created_at: string;
  updated_at?: string;
}

export interface CreateProductPOCInput {
  user_id: number;
  product_name: string;
  description?: string;
  price: number;
  total_quantity: number;
  available_quantity: number;
  image_id?: number;
}

export interface UpdateProductPOCInput {
  product_name?: string;
  description?: string;
  price?: number;
  total_quantity?: number;
  available_quantity?: number;
  image_id?: number;
}

// === Booking ===
export interface Booking {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  status: string; // booked / cancelled / completed
  booking_date: string;
  estimated_complete_at?: string; // เวลาที่คาดว่าจะเสร็จ (countdown)
  countdown_seconds?: number; // จำนวนวินาทีถอยหลังที่ random ได้
}

// === Countdown Status ===
export interface CountdownStatus {
  booking_id: number;
  status: string;
  countdown_seconds: number;
  estimated_complete_at: string;
  remaining_seconds: number;
  is_completed: boolean;
}

export interface CreateBookingInput {
  user_id: number;
  product_id: number;
  quantity: number;
}

// === BookingQueue ===
export interface BookingQueue {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  queue_number: number;
  status: string; // waiting / completed / cancelled
  created_at: string;
}

// === Log ===
export interface LogEntry {
  id: number;
  log_type: string; // activity / error / request
  http_status?: number;
  url?: string;
  description?: string;
  created_at: string;
}

export interface CreateLogInput {
  log_type: string;
  http_status?: number;
  url?: string;
  description?: string;
}

// === File ===
export interface FileRecord {
  id: number;
  file_name: string;
  file_path: string;
  file_type: string;
  uploaded_by?: number;
  created_at: string;
}

export interface CreateFileInput {
  file_name: string;
  file_path: string;
  file_type: string;
  uploaded_by?: number;
}
