-- Sign-in moves from email magic links to Google. Existing users are matched by email on first Google sign-in.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
DROP TABLE login_tokens;
