import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { JwtPayload, User } from "./types.js";

// 1. Cryptographic Hash helper (DB / RAM me plain OTP kabhi nahi jaata)
export function hashOtp(otp: string): string {
  return crypto.createHmac("sha256", config.jwt.accessSecret).update(otp).digest("hex");
}

// 2. Generate 6-digit OTP
export function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

// 3. Issue JWT Access & Refresh Tokens
export function generateTokens(user: User) {
  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    isProfileComplete: user.isProfileComplete,
  };

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: "15m",
  });

  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: "30d",
  });

  return { accessToken, refreshToken };
}

// 3b. Order access token — lets a guest view their own order without login.
// It's a signed HMAC of the order id, so order ids alone can't be enumerated.
export function generateOrderToken(orderId: string): string {
  return crypto.createHmac("sha256", config.jwt.accessSecret).update(`order:${orderId}`).digest("hex");
}

export function verifyOrderToken(orderId: string, token: string): boolean {
  if (!token) return false;
  const expected = generateOrderToken(orderId);
  // Constant-time compare to avoid timing leaks.
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 4. Verify Access Token
export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwt.accessSecret) as JwtPayload;
  } catch {
    return null;
  }
}

// 5. Verify Refresh Token
export function verifyRefreshToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwt.refreshSecret) as JwtPayload;
  } catch {
    return null;
  }
}
