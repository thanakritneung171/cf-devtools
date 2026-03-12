-- Create posts table
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  deleted_at TEXT
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_posts_user_id
ON posts(user_id);

-- Create index for status filtering
CREATE INDEX IF NOT EXISTS idx_posts_status
ON posts(status);