#!/usr/bin/env bash
# Reset admin password to match ~/apptraining/.env (run on VPS as root)
set -euo pipefail
docker exec apptraining node -e "
const argon2 = require('argon2');
const sqlite3 = require('sqlite3').verbose();
const pw = process.env.ADMIN_PASSWORD;
const user = process.env.ADMIN_USERNAME || 'admin';
if (!pw) {
  console.error('ADMIN_PASSWORD is not set in the container environment');
  process.exit(1);
}
const db = new sqlite3.Database('/app/data/training.db');
const opts = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4, saltLength: 16 };
argon2.hash(pw, opts).then((hash) => {
  db.run('UPDATE users SET password = ? WHERE username = ? AND role = ?', [hash, user, 'admin'], function (err) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    if (this.changes === 0) {
      db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [user, hash, 'admin'], (err2) => {
        if (err2) { console.error(err2); process.exit(1); }
        console.log('Created admin user:', user);
      });
    } else {
      console.log('Password updated for admin user:', user);
    }
  });
});
"
