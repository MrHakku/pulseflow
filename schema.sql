CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    brand_id INTEGER DEFAULT 1,
    content TEXT NOT NULL,
    platforms TEXT NOT NULL, -- JSON array of selected platforms
    status TEXT NOT NULL, -- 'queue', 'draft', 'sent'
    scheduled_date TEXT NOT NULL,
    media_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);