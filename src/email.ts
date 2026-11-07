import { Resend } from "resend";

import { config } from "./config.js";
import type { Order } from "./types.js";

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

const BRAND = "StickerHub";
const ACCENT = "#ff2a85";
const INK = "#0f172a";

function from(): string {
  return `${config.resend.fromName} <${config.resend.fromEmail}>`;
}

/** Send an email via Resend. Returns false on failure in production, true otherwise. */
async function send(to: string, subject: string, html: string): Promise<boolean> {
  if (!resend) {
    if (process.env.NODE_ENV === "production") {
      console.error("RESEND_API_KEY not set — email cannot be delivered.");
      return false;
    }
    console.log(`[DEV EMAIL] To: ${to} | Subject: ${subject}`);
    return true;
  }

  try {
    const { error } = await resend.emails.send({
      from: from(),
      to,
      replyTo: config.resend.replyTo,
      subject,
      html,
    });
    if (error) {
      console.warn("Resend error:", error.message);
      return process.env.NODE_ENV !== "production";
    }
    return true;
  } catch (err: any) {
    console.warn("Resend send failed:", err.message);
    return process.env.NODE_ENV !== "production";
  }
}

/** Wrap body content in the shared branded shell. */
function layout(title: string, body: string): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 14px; background:#ffffff;">
    <div style="text-align:center; margin-bottom: 8px;">
      <span style="display:inline-block; font-size: 22px; font-weight:700; color:${INK};">stickerhub<span style="color:${ACCENT}">.</span></span>
    </div>
    <h2 style="color:${INK}; margin: 8px 0 4px; text-align:center; font-size:20px;">${title}</h2>
    ${body}
    <hr style="border:none; border-top:1px solid #e2e8f0; margin:24px 0;" />
    <p style="color:#94a3b8; font-size:11px; text-align:center;">
      ${BRAND} · Premium waterproof stickers<br/>
      Need help? Reply to this email or write to ${config.resend.replyTo}.
    </p>
  </div>`;
}

function formatINR(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

// ---- OTP login code ----
export async function sendOtpEmail(email: string, otp: string): Promise<boolean> {
  const body = `
    <p style="color:#475569; font-size:15px; line-height:1.5; text-align:center;">
      Use the 6-digit code below to log in to your account.
    </p>
    <div style="text-align:center; margin:24px 0;">
      <span style="display:inline-block; font-size:32px; font-weight:700; letter-spacing:6px; color:${ACCENT}; background:#fff1f6; padding:12px 24px; border-radius:8px; border:1px dashed ${ACCENT};">${otp}</span>
    </div>
    <p style="color:#64748b; font-size:13px; line-height:1.4; text-align:center;">
      This code expires in <strong>5 minutes</strong>. If you didn't request it, you can ignore this email.
    </p>`;
  return send(email, `Your ${BRAND} login code: ${otp}`, layout("Your login code", body));
}

// ---- Order confirmation ----
export async function sendOrderConfirmationEmail(order: Order): Promise<boolean> {
  const rows = order.items
    .map(
      (item) =>
        `<tr>
          <td style="padding:8px 0; color:${INK}; font-size:14px;">${item.quantity}× ${item.name}</td>
          <td style="padding:8px 0; text-align:right; color:${INK}; font-size:14px; font-weight:600;">${formatINR(item.total)}</td>
        </tr>`
    )
    .join("");

  const addr = order.shippingAddress;
  const body = `
    <p style="color:#475569; font-size:15px; line-height:1.5; text-align:center;">
      Thanks, ${order.customer.name}! Your order is confirmed and we're getting it ready.
    </p>
    <div style="text-align:center; margin:16px 0;">
      <span style="display:inline-block; background:#f1f5f9; padding:8px 14px; border-radius:999px; font-size:13px; font-weight:700; color:${INK};">Order ${order.orderNumber}</span>
    </div>

    <table style="width:100%; border-collapse:collapse; margin-top:8px;">
      ${rows}
      <tr><td colspan="2" style="border-top:1px solid #e2e8f0; padding-top:8px;"></td></tr>
      <tr>
        <td style="padding:2px 0; color:#64748b; font-size:13px;">Subtotal</td>
        <td style="padding:2px 0; text-align:right; color:#64748b; font-size:13px;">${formatINR(order.subtotal)}</td>
      </tr>
      <tr>
        <td style="padding:2px 0; color:#64748b; font-size:13px;">Shipping</td>
        <td style="padding:2px 0; text-align:right; color:#16a34a; font-size:13px; font-weight:600;">${order.shippingFee === 0 ? "FREE" : formatINR(order.shippingFee)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0 0; color:${INK}; font-size:15px; font-weight:700;">Total paid</td>
        <td style="padding:6px 0 0; text-align:right; color:${INK}; font-size:15px; font-weight:700;">${formatINR(order.totalAmount)}</td>
      </tr>
    </table>

    <div style="margin-top:20px; background:#f8fafc; border-radius:10px; padding:14px;">
      <p style="margin:0 0 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:#94a3b8;">Shipping to</p>
      <p style="margin:0; color:${INK}; font-size:14px; font-weight:600;">${order.customer.name}</p>
      <p style="margin:2px 0 0; color:#64748b; font-size:13px;">${addr.street}</p>
      <p style="margin:0; color:#64748b; font-size:13px;">${addr.city}, ${addr.state} - ${addr.pincode}</p>
      <p style="margin:2px 0 0; color:#64748b; font-size:13px;">Phone: ${order.customer.phone}</p>
    </div>

    <div style="text-align:center; margin-top:22px;">
      <a href="${config.shopUrl}/order/${order.id}" style="display:inline-block; background:${INK}; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">Track your order</a>
    </div>`;
  return send(order.customer.email, `Order confirmed: ${order.orderNumber}`, layout("Order confirmed 🎉", body));
}

// ---- Order shipped ----
export async function sendOrderShippedEmail(order: Order): Promise<boolean> {
  const body = `
    <p style="color:#475569; font-size:15px; line-height:1.5; text-align:center;">
      Good news, ${order.customer.name} — your stickers are on the way!
    </p>
    <div style="text-align:center; margin:16px 0;">
      <span style="display:inline-block; background:#eff6ff; color:#1d4ed8; padding:8px 14px; border-radius:999px; font-size:13px; font-weight:700;">Order ${order.orderNumber} · Shipped</span>
    </div>
    <p style="color:#64748b; font-size:14px; line-height:1.5; text-align:center;">
      It should reach <strong>${order.shippingAddress.city}</strong> within 3–7 working days.
    </p>
    <div style="text-align:center; margin-top:22px;">
      <a href="${config.shopUrl}/order/${order.id}" style="display:inline-block; background:${INK}; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">View order</a>
    </div>`;
  return send(order.customer.email, `Your ${BRAND} order has shipped 🚚`, layout("On its way! 🚚", body));
}
