-- Insert sample posts

INSERT INTO posts (user_id, title, content, status)
VALUES
(1, 'Hello Cloudflare D12', 'This is my first post', 'published'),
(1, 'Learning Workers2', 'Workers are serverless edge functions', 'published'),
(2, 'Database Tips2', 'Use index for better performance', 'draft');