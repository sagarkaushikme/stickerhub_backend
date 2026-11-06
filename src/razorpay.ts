import crypto from "crypto";
import Razorpay from "razorpay";
import { config } from "./config.js";

// Initialize official Razorpay instance
export const razorpayInstance = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

/**
 * Creates an authoritative Razorpay order on Razorpay servers.
 * Always calculated on backend using DB prices, converted to paise.
 */
export async function createRazorpayOrder(amountInRupees: number, receiptId: string) {
  const amountInPaise = Math.round(amountInRupees * 100);

  const order = await razorpayInstance.orders.create({
    amount: amountInPaise,
    currency: "INR",
    receipt: receiptId,
    payment_capture: true, // Auto capture payment
  });

  return {
    id: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: config.razorpay.keyId,
  };
}

/**
 * Mathematically verifies the Razorpay signature using HMAC-SHA256.
 * Zero tampering possible.
 */
export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  if (!orderId || !paymentId || !signature) {
    return false;
  }

  const generatedSignature = crypto
    .createHmac("sha256", config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  return generatedSignature === signature;
}

/**
 * Verifies Razorpay Webhook signature to ensure the webhook genuinely came from Razorpay.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  if (!signature) return false;

  const expectedSignature = crypto
    .createHmac("sha256", config.razorpay.webhookSecret)
    .update(rawBody)
    .digest("hex");

  return expectedSignature === signature;
}
