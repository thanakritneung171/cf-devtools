CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT    NOT NULL,
  description TEXT  NOT NULL,
  price     REAL    NOT NULL CHECK(price >= 0),
  category  TEXT    NOT NULL,
  stock     INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
