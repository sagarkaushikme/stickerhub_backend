import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10, // Neon connection pool optimal setting
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export async function initDb() {
  const client = await pool.connect();
  try {
    console.log("🐘 Connecting to Neon PostgreSQL database...");

    // 1. Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        phone VARCHAR(20),
        role VARCHAR(32) DEFAULT 'CUSTOMER',
        is_profile_complete BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 2. OTP Sessions Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS otps (
        email VARCHAR(255) PRIMARY KEY,
        hashed_otp VARCHAR(255) NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INT DEFAULT 0,
        last_sent_at BIGINT NOT NULL
      );
    `);

    // 3. Products Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        price INT NOT NULL,
        original_price INT NOT NULL,
        images JSONB NOT NULL,
        background VARCHAR(32) NOT NULL,
        tag VARCHAR(100) NOT NULL,
        rating VARCHAR(10) NOT NULL,
        rating_count INT NOT NULL,
        description TEXT NOT NULL,
        stock INT NOT NULL DEFAULT 100,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 4. Orders Table with unique razorpay_payment_id constraint
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(64) PRIMARY KEY,
        order_number VARCHAR(64) UNIQUE NOT NULL,
        user_id VARCHAR(64) REFERENCES users(id),
        customer JSONB NOT NULL,
        shipping_address JSONB NOT NULL,
        items JSONB NOT NULL,
        subtotal INT NOT NULL,
        shipping_fee INT NOT NULL,
        total_amount INT NOT NULL,
        status VARCHAR(64) NOT NULL,
        razorpay_order_id VARCHAR(128) UNIQUE,
        razorpay_payment_id VARCHAR(128) UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 5. Store Settings Table (Announcement, Marquee, Promo banner)
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        key VARCHAR(64) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Seed default settings if empty
    await client.query(`
      INSERT INTO store_settings (key, value)
      VALUES 
        ('announcement', '{"text": "Free shipping across India · Waterproof die-cut", "active": true}'::jsonb),
        ('marquee', '{"text": "WATERPROOF DIE-CUT · SCRATCH RESISTANT · NO RESIDUE · GLOSSY FINISH", "active": true}'::jsonb)
      ON CONFLICT (key) DO NOTHING;
    `);

    // NOTE: Products are intentionally NOT seeded. The catalog is managed entirely
    // through the admin panel so the live store starts from a clean slate.
    // Helpful indexes for order lookups (see order history query).
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders((customer->>'email'));`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(LOWER(category));`);


    console.log("⚡ Neon PostgreSQL connected and schemas verified successfully!");
  } catch (err) {
    console.error("❌ Neon Database initialization error:", err);
    throw err;
  } finally {
    client.release();
  }
}

