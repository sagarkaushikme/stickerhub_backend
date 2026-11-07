import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  // Comma-separated list of allowed production origins (shop + admin).
  // Auto-expands each https://example.com entry to also allow https://www.example.com
  // so you don't need to list both variants in the env var.
  allowedOrigins: (() => {
    const raw = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const expanded = new Set<string>(raw);
    for (const origin of raw) {
      try {
        const url = new URL(origin);
        // If bare domain (no www), also add the www variant
        if (!url.hostname.startsWith("www.")) {
          expanded.add(`${url.protocol}//www.${url.hostname}${url.port ? `:${url.port}` : ""}`);
        }
        // If www domain, also add the bare variant
        if (url.hostname.startsWith("www.")) {
          expanded.add(`${url.protocol}//${url.hostname.slice(4)}${url.port ? `:${url.port}` : ""}`);
        }
      } catch {
        // Invalid URL — keep it as-is
      }
    }
    return [...expanded];
  })(),
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || "super_secret_access_jwt_key_99812",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "super_secret_refresh_jwt_key_99812",
    accessExpiresIn: "15m",
    refreshExpiresIn: "30d",
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || "",
    fromEmail: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
    fromName: process.env.RESEND_FROM_NAME || "StickerHub",
    replyTo: process.env.RESEND_REPLY_TO || "support@stickerhub.in",
  },
  // Public storefront URL used in email links.
  shopUrl: process.env.SHOP_URL || "https://stickerhub.in",
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_mock_key_id",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "mock_secret_key_12345",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "mock_webhook_secret",
  },
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",
  adminKey: process.env.ADMIN_KEY || "peelgood_admin_secret_2026",
  // Cloudflare R2 (S3-compatible) for product image uploads.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET || "",
    // The public base URL for the bucket (R2 public dev URL or your CDN domain).
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || "",
  },
};

export const isR2Configured = Boolean(
  config.r2.accountId &&
    config.r2.accessKeyId &&
    config.r2.secretAccessKey &&
    config.r2.bucket &&
    config.r2.publicBaseUrl
);
