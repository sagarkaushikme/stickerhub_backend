import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "./auth.js";
import { config } from "./config.js";
import { JwtPayload } from "./types.js";

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required. Please log in.",
    });
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      message: "Session expired or invalid token. Please log in again.",
    });
  }

  req.user = payload;
  return next();
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.cookies?.accessToken;

  // Secret admin header key for quick admin panel access or verified ADMIN JWT.
  // The key is configurable via the ADMIN_KEY env var (set a strong value in production).
  const adminSecret = req.headers["x-admin-key"];
  if (adminSecret && adminSecret === config.adminKey) {
    return next();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Admin authentication required.",
    });
  }

  const payload = verifyAccessToken(token);
  if (!payload || payload.role !== "ADMIN") {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Admin privileges required.",
    });
  }

  req.user = payload;
  return next();
}

export function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.cookies?.accessToken;

  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) {
      req.user = payload;
    }
  }
  return next();
}

