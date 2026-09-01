// Bootstraps an admin account. Password is hashed here before it ever
// touches the database — pass it in plain, it's stored safely.
//
// Usage: node scripts/create-admin.mjs <username> <password> <name>
import "dotenv/config";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import pkg from "pg";

const { Pool } = pkg;

const [username, password, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ");

if (!username || !password || !name) {
  console.error("Usage: node scripts/create-admin.mjs <username> <password> <name>");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO cliniq.admins (id, username, password_hash, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name
     RETURNING id, username, name`,
    [uuid(), username, passwordHash, name]
  );
  console.log("Admin ready:", rows[0]);
} finally {
  await pool.end();
}
