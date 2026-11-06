export type Role = "CUSTOMER" | "ADMIN";

export type User = {
  id: string;
  email: string;
  name?: string;
  phone?: string;
  role: Role;
  isProfileComplete: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OtpRecord = {
  email: string;
  hashedOtp: string;
  expiresAt: number; // timestamp ms
  attempts: number; // max 3 wrong attempts
  lastSentAt: number; // cooldown timestamp ms
};

export type JwtPayload = {
  userId: string;
  email: string;
  role: Role;
  isProfileComplete: boolean;
};

export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  originalPrice: number;
  images: string[];
  background: "lemon" | "coral" | "mint";
  tag: string;
  rating: string;
  ratingCount: number;
  description: string;
  stock: number;
};

export type OrderItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  total: number;
};

export type Customer = {
  name: string;
  email: string;
  phone: string;
};

export type ShippingAddress = {
  street: string;
  city: string;
  state: string;
  pincode: string;
};

export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PAYMENT_CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED";

export type Order = {
  id: string;
  orderNumber: string;
  userId?: string;
  customer: Customer;
  shippingAddress: ShippingAddress;
  items: OrderItem[];
  subtotal: number;
  shippingFee: number;
  totalAmount: number;
  status: OrderStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  createdAt: string;
  updatedAt: string;
};
