import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import multer from "multer";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { config, isR2Configured } from "./config.js";
import { uploadImage } from "./storage.js";
import { pool, initDb } from "./db.js";
import {
  generateOtp,
  hashOtp,
  generateTokens,
  verifyRefreshToken,
  generateOrderToken,
  verifyOrderToken,
  verifyAccessToken,
} from "./auth.js";
import {
  sendOtpEmail,
  sendOrderConfirmationEmail,
  sendOrderShippedEmail,
} from "./email.js";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  verifyWebhookSignature,
} from "./razorpay.js";
import {
  requireAuth,
  requireAdmin,
  optionalAuth,
  AuthenticatedRequest,
} from "./middleware.js";
import { User, Order, OrderItem } from "./types.js";

const app = express();

// Trust the first proxy (required for correct client IPs behind Railway/Render/Cloudflare).
app.set("trust proxy", 1);

// Security headers.
app.use(helmet());

// General rate limit: 300 requests / 15 min per IP across the API.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please slow down." },
});

// Strict limit for auth/OTP: 10 requests / 10 min per IP.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please wait a few minutes and try again." },
});

// Checkout + upload limit: 30 requests / 10 min per IP.
const sensitiveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      // No origin: mobile apps, curl, server-to-server, same-origin.
      if (!origin) return callback(null, true);
      // Always allow local dev on any port.
      if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
        return callback(null, true);
      }
      // In production, allow only the configured shop + admin origins.
      if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Razorpay-Signature", "x-admin-key"],
  })
);

app.use(cookieParser());

// Webhook needs raw body
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Apply the general rate limit to all API routes except the Razorpay webhook
// (Razorpay retries webhooks and must never be throttled).
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  return generalLimiter(req, res, next);
});

// -------------------------------------------------------------
// 1. HEALTH & METRICS
// -------------------------------------------------------------
app.get("/api/health", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1;");
    return res.json({
      status: "ok",
      service: "stickerhub-backend",
      db: "connected",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// -------------------------------------------------------------
// 2. AUTHENTICATION (NEON POSTGRESQL + RESEND OTP)
// -------------------------------------------------------------

// Step 1: Request OTP
const SendOtpSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

app.post("/api/auth/send-otp", authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = SendOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Valid email is required" });
    }

    const { email } = parsed.data;
    const now = Date.now();

    // Check existing OTP in Neon DB for cooldown
    const existingRes = await pool.query("SELECT * FROM otps WHERE email = $1;", [email]);
    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      const lastSent = Number(existing.last_sent_at);
      if (now - lastSent < 60 * 1000) {
        const waitSeconds = Math.ceil((60 * 1000 - (now - lastSent)) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${waitSeconds} seconds before requesting a new code`,
        });
      }
    }

    const rawOtp = generateOtp();
    const hashedOtp = hashOtp(rawOtp);
    const expiresAt = now + 5 * 60 * 1000; // 5 mins TTL

    // Upsert into Neon DB
    await pool.query(
      `INSERT INTO otps (email, hashed_otp, expires_at, attempts, last_sent_at)
       VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT (email)
       DO UPDATE SET hashed_otp = $2, expires_at = $3, attempts = 0, last_sent_at = $4;`,
      [email, hashedOtp, expiresAt, now]
    );

    // Send real email via Resend
    const isSent = await sendOtpEmail(email, rawOtp);
    if (!isSent) {
      return res.status(500).json({ success: false, message: "Failed to send email. Check Resend config." });
    }

    return res.json({
      success: true,
      message: "One-time code sent to your email",
      expiresIn: 300,
    });
  } catch (error: any) {
    console.error("send-otp error:", error);
    return res.status(500).json({ success: false, message: "Server error sending OTP" });
  }
});

// Step 2: Verify OTP
const VerifyOtpSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  otp: z.string().length(6),
  name: z.string().optional(),
  phone: z.string().optional(),
});

app.post("/api/auth/verify-otp", authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = VerifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid email or 6-digit OTP" });
    }

    const { email, otp, name: providedName, phone: providedPhone } = parsed.data;
    const now = Date.now();

    const otpRes = await pool.query("SELECT * FROM otps WHERE email = $1;", [email]);
    if (otpRes.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No active verification code found. Please request a new one.",
      });
    }

    const otpRecord = otpRes.rows[0];

    // Expiration check
    if (now > Number(otpRecord.expires_at)) {
      await pool.query("DELETE FROM otps WHERE email = $1;", [email]);
      return res.status(400).json({
        success: false,
        message: "Code has expired. Please request a new one.",
      });
    }

    // Brute force protection (Max 3 attempts)
    if (otpRecord.attempts >= 3) {
      await pool.query("DELETE FROM otps WHERE email = $1;", [email]);
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Code invalidated. Please request a new one.",
      });
    }

    // Hash check
    const hashedInput = hashOtp(otp);
    if (hashedInput !== otpRecord.hashed_otp) {
      await pool.query("UPDATE otps SET attempts = attempts + 1 WHERE email = $1;", [email]);
      const remaining = 2 - otpRecord.attempts;
      return res.status(400).json({
        success: false,
        message: `Incorrect code. ${remaining > 0 ? remaining : 0} attempts remaining.`,
      });
    }

    // Valid OTP! Delete OTP record immediately
    await pool.query("DELETE FROM otps WHERE email = $1;", [email]);

    // Check if user already exists in Neon DB
    const userRes = await pool.query("SELECT * FROM users WHERE email = $1;", [email]);
    let user: User;
    let isExisting = false;

    if (userRes.rows.length > 0) {
      const row = userRes.rows[0];
      isExisting = true;

      // Smart Update: If existing user had no name/phone and now provided it, fill it
      const shouldUpdate =
        (!row.name && providedName) ||
        (!row.phone && providedPhone);

      if (shouldUpdate) {
        const updateRes = await pool.query(
          `UPDATE users
           SET name = COALESCE(name, $1),
               phone = COALESCE(phone, $2),
               is_profile_complete = TRUE,
               updated_at = NOW()
           WHERE id = $3
           RETURNING *;`,
          [providedName || null, providedPhone || null, row.id]
        );
        const updatedRow = updateRes.rows[0];
        user = {
          id: updatedRow.id,
          email: updatedRow.email,
          name: updatedRow.name,
          phone: updatedRow.phone,
          role: updatedRow.role,
          isProfileComplete: updatedRow.is_profile_complete,
          createdAt: updatedRow.created_at,
          updatedAt: updatedRow.updated_at,
        };
      } else {
        user = {
          id: row.id,
          email: row.email,
          name: row.name,
          phone: row.phone,
          role: row.role,
          isProfileComplete: row.is_profile_complete,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }
    } else {
      // Brand new user registration
      const newUserId = `usr_${crypto.randomBytes(8).toString("hex")}`;
      const isComplete = Boolean(providedName && providedPhone);

      const insertRes = await pool.query(
        `INSERT INTO users (id, email, name, phone, role, is_profile_complete)
         VALUES ($1, $2, $3, $4, 'CUSTOMER', $5)
         RETURNING *;`,
        [newUserId, email, providedName || null, providedPhone || null, isComplete]
      );
      const row = insertRes.rows[0];
      user = {
        id: row.id,
        email: row.email,
        name: row.name,
        phone: row.phone,
        role: row.role,
        isProfileComplete: row.is_profile_complete,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }

    const { accessToken, refreshToken } = generateTokens(user);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      isExistingUser: isExisting,
      message: isExisting ? `Welcome back, ${user.name || "friend"}!` : "Account created successfully!",
      accessToken,
      user,
    });
  } catch (error) {
    console.error("verify-otp error:", error);
    return res.status(500).json({ success: false, message: "Server error verifying code" });
  }
});

// Step 3: Complete Profile
const CompleteProfileSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").trim(),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Please enter a valid 10-digit Indian phone number"),
});

app.post("/api/auth/complete-profile", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = CompleteProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile data",
        errors: parsed.error.format(),
      });
    }

    const { name, phone } = parsed.data;
    const userId = req.user!.userId;

    const updateRes = await pool.query(
      `UPDATE users
       SET name = $1, phone = $2, is_profile_complete = TRUE, updated_at = NOW()
       WHERE id = $3
       RETURNING *;`,
      [name, phone, userId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const row = updateRes.rows[0];
    const user: User = {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      role: row.role,
      isProfileComplete: row.is_profile_complete,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const { accessToken } = generateTokens(user);

    return res.json({
      success: true,
      message: "Profile updated successfully",
      accessToken,
      user,
    });
  } catch (error) {
    console.error("complete-profile error:", error);
    return res.status(500).json({ success: false, message: "Failed to update profile" });
  }
});

// Step 4: Refresh Access Token
app.post("/api/auth/refresh", async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    return res.status(401).json({ success: false, message: "Refresh token missing" });
  }

  const payload = verifyRefreshToken(token);
  if (!payload) {
    return res.status(401).json({ success: false, message: "Invalid refresh token" });
  }

  const userRes = await pool.query("SELECT * FROM users WHERE id = $1;", [payload.userId]);
  if (userRes.rows.length === 0) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const row = userRes.rows[0];
  const user: User = {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: row.role,
    isProfileComplete: row.is_profile_complete,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  const tokens = generateTokens(user);
  return res.json({ success: true, accessToken: tokens.accessToken });
});

// Step 5: Get Current User Profile
app.get("/api/auth/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userRes = await pool.query("SELECT * FROM users WHERE id = $1;", [req.user!.userId]);
  if (userRes.rows.length === 0) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const row = userRes.rows[0];
  return res.json({
    success: true,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      role: row.role,
      isProfileComplete: row.is_profile_complete,
    },
  });
});

// Step 6: Logout
app.post("/api/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie("refreshToken");
  return res.json({ success: true, message: "Logged out successfully" });
});

// -------------------------------------------------------------
// 7. STORE SETTINGS & ANNOUNCEMENTS (PUBLIC & ADMIN)
// -------------------------------------------------------------
app.get("/api/settings", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT * FROM store_settings;");
    const settings: Record<string, any> = {};
    for (const row of result.rows) {
      settings[row.key] = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    }
    return res.json({ success: true, data: settings });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/settings/:key", requireAdmin, async (req: Request, res: Response) => {
  try {
    const key = req.params.key;
    const value = req.body;
    await pool.query(
      `INSERT INTO store_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW();`,
      [key, JSON.stringify(value)]
    );
    return res.json({ success: true, message: `Setting '${key}' updated successfully` });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: Quick Stock Adjustment (+10, +50, etc.)
app.patch("/api/admin/products/:id/stock", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { delta } = req.body;
    if (typeof delta !== "number") {
      return res.status(400).json({ success: false, message: "delta must be a number" });
    }
    const result = await pool.query(
      "UPDATE products SET stock = GREATEST(0, stock + $1) WHERE id = $2 RETURNING *;",
      [delta, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.json({ success: true, message: "Stock updated", product: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});
// Image upload (admin only). Accepts one or more image files and returns their public URLs.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
});

app.get("/api/admin/upload/status", requireAdmin, (_req: Request, res: Response) => {
  return res.json({ success: true, configured: isR2Configured });
});

app.post(
  "/api/admin/upload",
  sensitiveLimiter,
  requireAdmin,
  upload.array("files", 6),
  async (req: Request, res: Response) => {
    try {
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        return res.status(400).json({ success: false, message: "No files uploaded" });
      }

      const urls = await Promise.all(
        files.map((file) => uploadImage(file.buffer, file.mimetype))
      );

      return res.json({ success: true, urls });
    } catch (err: any) {
      console.error("Upload error:", err);
      return res.status(400).json({ success: false, message: err.message || "Upload failed" });
    }
  }
);

const ProductSchema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  price: z.number().int().positive(),
  originalPrice: z.number().int().positive(),
  images: z.array(z.string().min(1)).min(1),
  background: z.enum(["lemon", "coral", "mint"]),
  tag: z.string().min(1),
  description: z.string().min(5),
  stock: z.number().int().min(0),
  rating: z.string().optional(),
  ratingCount: z.number().int().min(0).optional(),
});

// Admin: Create Product
app.post("/api/admin/products", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = ProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid product data", errors: parsed.error.format() });
    }

    const { name, category, price, originalPrice, images, background, tag, description, stock, rating, ratingCount } = parsed.data;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + `-${Date.now().toString().slice(-4)}`;

    const dbRes = await pool.query(
      `INSERT INTO products (id, name, category, price, original_price, images, background, tag, rating, rating_count, description, stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *;`,
      [id, name, category, price, originalPrice, JSON.stringify(images), background, tag, rating ?? "5.0", ratingCount ?? 0, description, stock]
    );

    return res.status(201).json({ success: true, message: "Product created successfully", id, data: mapProduct(dbRes.rows[0]) });
  } catch (err: any) {
    console.error("Create product error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: Update Product
app.put("/api/admin/products/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const parsed = ProductSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid update data" });
    }

    const fields = parsed.data;
    const updates: string[] = [];
    const values: any[] = [];

    if (fields.name) {
      values.push(fields.name);
      updates.push(`name = $${values.length}`);
    }
    if (fields.category) {
      values.push(fields.category);
      updates.push(`category = $${values.length}`);
    }
    if (fields.price !== undefined) {
      values.push(fields.price);
      updates.push(`price = $${values.length}`);
    }
    if (fields.originalPrice !== undefined) {
      values.push(fields.originalPrice);
      updates.push(`original_price = $${values.length}`);
    }
    if (fields.images) {
      values.push(JSON.stringify(fields.images));
      updates.push(`images = $${values.length}`);
    }
    if (fields.background) {
      values.push(fields.background);
      updates.push(`background = $${values.length}`);
    }
    if (fields.tag) {
      values.push(fields.tag);
      updates.push(`tag = $${values.length}`);
    }
    if (fields.description) {
      values.push(fields.description);
      updates.push(`description = $${values.length}`);
    }
    if (fields.stock !== undefined) {
      values.push(fields.stock);
      updates.push(`stock = $${values.length}`);
    }
    if (fields.rating !== undefined) {
      values.push(fields.rating);
      updates.push(`rating = $${values.length}`);
    }
    if (fields.ratingCount !== undefined) {
      values.push(fields.ratingCount);
      updates.push(`rating_count = $${values.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(id);
    const query = `UPDATE products SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *;`;
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    return res.json({ success: true, message: "Product updated successfully", data: mapProduct(result.rows[0]) });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: Delete Product
app.delete("/api/admin/products/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const result = await pool.query("DELETE FROM products WHERE id = $1 RETURNING id;", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.json({ success: true, message: "Product deleted successfully" });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: Get All Orders (With stats)
app.get("/api/admin/orders", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC;");
    const orders = result.rows.map((r) => ({
      ...r,
      orderNumber: r.order_number,
      totalAmount: r.total_amount,
      shippingFee: r.shipping_fee,
      customer: typeof r.customer === "string" ? JSON.parse(r.customer) : r.customer,
      shippingAddress: typeof r.shipping_address === "string" ? JSON.parse(r.shipping_address) : r.shipping_address,
      items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
    }));

    // Calculate Admin metrics
    const totalRevenue = orders
      .filter((o) => o.status === "PAYMENT_CONFIRMED" || o.status === "SHIPPED" || o.status === "DELIVERED")
      .reduce((sum, o) => sum + o.totalAmount, 0);

    const metrics = {
      totalOrders: orders.length,
      confirmedOrders: orders.filter((o) => o.status === "PAYMENT_CONFIRMED").length,
      shippedOrders: orders.filter((o) => o.status === "SHIPPED").length,
      totalRevenue,
    };

    return res.json({ success: true, metrics, orders });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: Update Order Status
app.patch("/api/admin/orders/:id/status", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const allowed = ["PENDING_PAYMENT", "PAYMENT_CONFIRMED", "PAYMENT_FAILED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value" });
    }

    const result = await pool.query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *;",
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Notify the customer when their order ships.
    if (status === "SHIPPED") {
      const r = result.rows[0];
      const customer = typeof r.customer === "string" ? JSON.parse(r.customer) : r.customer;
      const shippingAddress =
        typeof r.shipping_address === "string" ? JSON.parse(r.shipping_address) : r.shipping_address;
      const items = typeof r.items === "string" ? JSON.parse(r.items) : r.items;
      sendOrderShippedEmail({
        id: r.id,
        orderNumber: r.order_number,
        customer,
        shippingAddress,
        items,
        subtotal: r.subtotal,
        shippingFee: r.shipping_fee,
        totalAmount: r.total_amount,
        status: "SHIPPED",
      } as any).catch((e) => console.warn("Shipped email failed:", e?.message));
    }

    return res.json({ success: true, message: `Order status updated to ${status}` });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});
// Map a raw products DB row to a clean camelCase DTO for the storefront.
function mapProduct(r: any) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    price: r.price,
    originalPrice: r.original_price,
    images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
    background: r.background,
    tag: r.tag,
    rating: r.rating,
    ratingCount: r.rating_count,
    description: r.description,
    stock: r.stock,
    createdAt: r.created_at,
  };
}

app.get("/api/products", async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const search = req.query.search as string | undefined;

    let query = "SELECT * FROM products";
    const params: any[] = [];
    const conditions: string[] = [];

    if (category && category !== "All stickers") {
      params.push(category);
      conditions.push(`LOWER(category) = LOWER($${params.length})`);
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conditions.push(
        `(LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length} OR LOWER(category) LIKE $${params.length})`
      );
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY created_at DESC;";

    const dbRes = await pool.query(query, params);
    const data = dbRes.rows.map(mapProduct);

    return res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error: any) {
    console.error("Products query error:", error);
    return res.status(500).json({ success: false, message: "Failed to load products" });
  }
});

// Distinct categories across the live catalog, so the storefront filter chips
// are driven by real data instead of a hardcoded list.
app.get("/api/categories", async (_req: Request, res: Response) => {
  try {
    const dbRes = await pool.query(
      "SELECT category, COUNT(*)::int AS count FROM products GROUP BY category ORDER BY category ASC;"
    );
    return res.json({
      success: true,
      data: dbRes.rows.map((r) => ({ name: r.category, count: r.count })),
    });
  } catch (err: any) {
    console.error("Categories query error:", err);
    return res.status(500).json({ success: false, message: "Failed to load categories" });
  }
});

app.get("/api/products/:id", async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const dbRes = await pool.query("SELECT * FROM products WHERE id = $1;", [id]);
    if (dbRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.json({ success: true, data: mapProduct(dbRes.rows[0]) });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// 4. CHECKOUT & ORDERS (NEON POSTGRESQL + RAZORPAY)
// -------------------------------------------------------------
const CheckoutSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string(),
      quantity: z.number().int().positive().max(20),
    })
  ).min(1),
  customer: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(10),
  }),
  shippingAddress: z.object({
    street: z.string().min(5),
    city: z.string().min(2),
    state: z.string().min(2),
    pincode: z.string().length(6),
  }),
});

app.post("/api/checkout/create-order", sensitiveLimiter, optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid checkout data",
        errors: parsed.error.format(),
      });
    }

    const { items: cartItems, customer, shippingAddress } = parsed.data;

    // Fetch products from Neon DB
    const productIds = cartItems.map((i) => i.productId);
    const prodRes = await pool.query(
      `SELECT * FROM products WHERE id = ANY($1::varchar[]);`,
      [productIds]
    );

    const productsMap = new Map(prodRes.rows.map((p) => [p.id, p]));

    const orderItems: OrderItem[] = [];
    let subtotal = 0;

    for (const item of cartItems) {
      const product = productsMap.get(item.productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product with ID ${item.productId} not found`,
        });
      }

      if (product.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.stock}`,
        });
      }

      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;

      orderItems.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
        total: lineTotal,
      });
    }

    const shippingFee = 0; // Promotional free shipping
    const totalAmount = subtotal + shippingFee;

    const orderId = `pg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const orderNumber = `PG-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

    // Create Razorpay Order
    const razorpayOrder = await createRazorpayOrder(totalAmount, orderId);

    // Insert order into Neon DB
    await pool.query(
      `INSERT INTO orders (id, order_number, user_id, customer, shipping_address, items, subtotal, shipping_fee, total_amount, status, razorpay_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_PAYMENT', $10);`,
      [
        orderId,
        orderNumber,
        req.user?.userId || null,
        JSON.stringify(customer),
        JSON.stringify(shippingAddress),
        JSON.stringify(orderItems),
        subtotal,
        shippingFee,
        totalAmount,
        razorpayOrder.id,
      ]
    );

    return res.status(201).json({
      success: true,
      data: {
        orderId,
        orderNumber,
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId: razorpayOrder.keyId,
        customer,
        // Signed token so the (possibly guest) buyer can view this order's status page.
        orderToken: generateOrderToken(orderId),
      },
    });
  } catch (error: any) {
    console.error("Error creating order:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Verify Payment
const VerifyPaymentSchema = z.object({
  orderId: z.string(),
  razorpayOrderId: z.string(),
  razorpayPaymentId: z.string(),
  razorpaySignature: z.string(),
});

app.post("/api/checkout/verify-payment", sensitiveLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = VerifyPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

    const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1;", [orderId]);
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const order = orderRes.rows[0];

    // Check if already paid (Idempotency)
    if (order.status === "PAYMENT_CONFIRMED") {
      return res.json({
        success: true,
        message: "Payment already confirmed",
        order: {
          orderId: order.id,
          orderNumber: order.order_number,
          status: "PAYMENT_CONFIRMED",
        },
      });
    }

    // 1. HMAC-SHA256 Signature Verification
    const isValid = verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) {
      console.error(`🚨 Security Alert: Signature mismatch for Order ${orderId}`);
      // Only flag a still-pending order as failed; never touch a confirmed order.
      await pool.query(
        "UPDATE orders SET status = 'PAYMENT_FAILED', updated_at = NOW() WHERE id = $1 AND status = 'PENDING_PAYMENT';",
        [orderId]
      );
      return res.status(400).json({ success: false, message: "Invalid payment signature. Payment cannot be verified." });
    }

    // 2. Atomic DB Transaction: Commit order status & decrement stock
    const client = await pool.connect();
    try {
      await client.query("BEGIN;");

      // Mark order confirmed
      await client.query(
        `UPDATE orders
         SET status = 'PAYMENT_CONFIRMED', razorpay_payment_id = $1, updated_at = NOW()
         WHERE id = $2;`,
        [razorpayPaymentId, orderId]
      );

      // Decrement inventory safely
      const items = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
      for (const item of items) {
        await client.query(
          `UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2;`,
          [item.quantity, item.productId]
        );
      }

      await client.query("COMMIT;");
    } catch (txErr) {
      await client.query("ROLLBACK;");
      throw txErr;
    } finally {
      client.release();
    }

    console.log(`✅ Payment successfully captured for Order #${order.order_number} (Razorpay ID: ${razorpayPaymentId})`);

    // Send the order confirmation email (don't block the response on it).
    const customer = typeof order.customer === "string" ? JSON.parse(order.customer) : order.customer;
    const shippingAddress =
      typeof order.shipping_address === "string" ? JSON.parse(order.shipping_address) : order.shipping_address;
    const orderItems = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
    sendOrderConfirmationEmail({
      id: order.id,
      orderNumber: order.order_number,
      customer,
      shippingAddress,
      items: orderItems,
      subtotal: order.subtotal,
      shippingFee: order.shipping_fee,
      totalAmount: order.total_amount,
      status: "PAYMENT_CONFIRMED",
    } as any).catch((e) => console.warn("Confirmation email failed:", e?.message));

    return res.json({
      success: true,
      message: "Payment verified successfully",
      order: {
        orderId: order.id,
        orderNumber: order.order_number,
        status: "PAYMENT_CONFIRMED",
      },
    });
  } catch (err: any) {
    console.error("Payment verification error:", err);
    return res.status(500).json({ success: false, message: "Verification failed" });
  }
});

// Razorpay Webhook
app.post("/api/webhooks/razorpay", async (req: any, res: Response) => {
  try {
    const signature = req.headers["x-razorpay-signature"] as string;
    const rawBody = req.rawBody || JSON.stringify(req.body);

    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ status: "invalid signature" });
    }

    const event = req.body;

    if (event.event === "payment.captured" || event.event === "order.paid") {
      const paymentEntity = event.payload?.payment?.entity;
      const rzpOrderId = paymentEntity?.order_id;
      const rzpPaymentId = paymentEntity?.id;

      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Only confirm orders that are still pending — never downgrade a
        // PROCESSING/SHIPPED/DELIVERED order back to PAYMENT_CONFIRMED.
        const upd = await client.query(
          `UPDATE orders
             SET status = 'PAYMENT_CONFIRMED', razorpay_payment_id = COALESCE(razorpay_payment_id, $1), updated_at = NOW()
           WHERE razorpay_order_id = $2 AND status = 'PENDING_PAYMENT'
           RETURNING items;`,
          [rzpPaymentId, rzpOrderId]
        );

        // If this webhook is the one that confirmed the order, decrement stock
        // (the browser verify-payment path may never have run).
        if (upd.rows.length > 0) {
          const items =
            typeof upd.rows[0].items === "string" ? JSON.parse(upd.rows[0].items) : upd.rows[0].items;
          for (const item of items) {
            await client.query(
              `UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2;`,
              [item.quantity, item.productId]
            );
          }
        }

        await client.query("COMMIT;");

        // If the webhook confirmed the order (not the browser), send the receipt.
        if (upd.rows.length > 0) {
          const full = await pool.query("SELECT * FROM orders WHERE razorpay_order_id = $1;", [rzpOrderId]);
          if (full.rows.length > 0) {
            const r = full.rows[0];
            const customer = typeof r.customer === "string" ? JSON.parse(r.customer) : r.customer;
            const shippingAddress =
              typeof r.shipping_address === "string" ? JSON.parse(r.shipping_address) : r.shipping_address;
            const items = typeof r.items === "string" ? JSON.parse(r.items) : r.items;
            sendOrderConfirmationEmail({
              id: r.id,
              orderNumber: r.order_number,
              customer,
              shippingAddress,
              items,
              subtotal: r.subtotal,
              shippingFee: r.shipping_fee,
              totalAmount: r.total_amount,
              status: "PAYMENT_CONFIRMED",
            } as any).catch((e) => console.warn("Webhook confirmation email failed:", e?.message));
          }
        }
      } catch (txErr) {
        await client.query("ROLLBACK;");
        throw txErr;
      } finally {
        client.release();
      }
    } else if (event.event === "payment.failed") {
      const paymentEntity = event.payload?.payment?.entity;
      const rzpOrderId = paymentEntity?.order_id;
      // Mark failed only if still pending, so a confirmed order is never flipped.
      await pool.query(
        `UPDATE orders SET status = 'PAYMENT_FAILED', updated_at = NOW()
         WHERE razorpay_order_id = $1 AND status = 'PENDING_PAYMENT';`,
        [rzpOrderId]
      );
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ status: "error" });
  }
});

// User's Order History
app.get("/api/user/orders", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ordersRes = await pool.query(
      `SELECT * FROM orders
       WHERE user_id = $1 OR customer->>'email' = $2
       ORDER BY created_at DESC;`,
      [req.user!.userId, req.user!.email]
    );

    const data = ordersRes.rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      customer: typeof r.customer === "string" ? JSON.parse(r.customer) : r.customer,
      shippingAddress: typeof r.shipping_address === "string" ? JSON.parse(r.shipping_address) : r.shipping_address,
      items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
      subtotal: r.subtotal,
      shippingFee: r.shipping_fee,
      totalAmount: r.total_amount,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: "Failed to load orders" });
  }
});

// Single Order Lookup — requires proof of ownership:
// either a signed order token (?token=) or a logged-in user who owns the order.
app.get("/api/orders/:orderId", async (req: Request, res: Response) => {
  try {
    const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
    const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1;", [orderId]);
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const r = orderRes.rows[0];

    // Authorize: valid order token, OR logged-in owner (by user_id or email).
    const token = (req.query.token as string) || "";
    let authorized = verifyOrderToken(orderId, token);

    if (!authorized) {
      const authHeader = req.headers.authorization;
      const jwtToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.accessToken;
      const payload = jwtToken ? verifyAccessToken(jwtToken) : null;
      if (payload) {
        const customer = typeof r.customer === "string" ? JSON.parse(r.customer) : r.customer;
        authorized =
          payload.role === "ADMIN" ||
          r.user_id === payload.userId ||
          customer?.email === payload.email;
      }
    }

    if (!authorized) {
      return res.status(403).json({ success: false, message: "Not authorized to view this order" });
    }

    return res.json({
      success: true,
      data: {
        id: r.id,
        orderNumber: r.order_number,
        customer: typeof r.customer === "string" ? JSON.parse(r.customer) : r.customer,
        shippingAddress: typeof r.shipping_address === "string" ? JSON.parse(r.shipping_address) : r.shipping_address,
        items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
        subtotal: r.subtotal,
        shippingFee: r.shipping_fee,
        totalAmount: r.total_amount,
        status: r.status,
        razorpayOrderId: r.razorpay_order_id,
        razorpayPaymentId: r.razorpay_payment_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Global error handler (last middleware). Keeps internal errors out of responses.
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return;
  res.status(err?.statusCode || 500).json({ success: false, message: "Internal server error" });
});

// Report which required production config is missing/insecure.
function productionConfigProblems(): string[] {
  if (process.env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) problems.push("JWT secrets");
  if (!process.env.ADMIN_KEY || process.env.ADMIN_KEY === "peelgood_admin_secret_2026") problems.push("ADMIN_KEY");
  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL");
  if (!process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET === "mock_secret_key_12345")
    problems.push("Razorpay secret");
  return problems;
}

// Graceful shutdown so in-flight requests finish and the DB pool closes cleanly.
function attachShutdown(server: ReturnType<typeof app.listen>) {
  const shutdown = (signal: string) => {
    console.log(`${signal} received — shutting down gracefully...`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Start Server
const PORT = config.port;
const configProblems = productionConfigProblems();

if (configProblems.length > 0) {
  // Misconfigured in production. Instead of crash-looping (which floods logs and
  // never lets you diagnose), start a minimal server that reports the problem
  // clearly on /api/health and refuses real traffic with a 503.
  console.error(
    `❌ Missing/insecure production config → ${configProblems.join(", ")}. ` +
      `Set these environment variables on your host, then redeploy.`
  );

  const minimal = express();
  minimal.get("/api/health", (_req, res) =>
    res.status(503).json({
      status: "misconfigured",
      missing: configProblems,
      message: "Set the required environment variables on your host, then redeploy.",
    })
  );
  minimal.use((_req, res) =>
    res.status(503).json({ success: false, message: "Service not configured. Contact the administrator." })
  );
  const server = minimal.listen(PORT, () => {
    console.error(`⚠️  StickerHub backend started in DEGRADED mode on port ${PORT} (config incomplete).`);
  });
  attachShutdown(server);
} else {
  initDb()
    .then(() => {
      const server = app.listen(PORT, () => {
        console.log(`🚀 StickerHub backend running on port ${PORT}`);
      });
      attachShutdown(server);
    })
    .catch((err) => {
      console.error("Failed to start server due to DB connection:", err);
      process.exit(1);
    });
}
