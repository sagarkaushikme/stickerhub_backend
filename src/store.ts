import { Product, Order, User, OtpRecord } from "./types.js";

// Users Table (key: userId)
export const users: Map<string, User> = new Map();

// Users by email lookup (key: email)
export const usersByEmail: Map<string, string> = new Map();

// OTP Store (key: lowercase email)
export const otpStore: Map<string, OtpRecord> = new Map();

// Orders Store
export const orders: Map<string, Order> = new Map();

// Stock reservations
export const stockReservations: Map<string, { productId: string; quantity: number; expiresAt: number }> = new Map();

// Products Catalog
export const products: Product[] = [
  {
    id: "late-brake-club",
    name: "Late Brake Club",
    category: "Cars & bikes",
    price: 10,
    originalPrice: 79,
    images: [
      "/assets/sticker-set-cars.jpg",
      "/assets/sticker-set-cars-detail-1.jpg",
      "/assets/sticker-set-cars-detail-2.jpg",
    ],
    background: "lemon",
    tag: "Fan favourite",
    rating: "4.9",
    ratingCount: 218,
    description:
      "For the friend who is always five minutes late but somehow first to the chai stall. A glossy die-cut with just enough chaos for your laptop, helmet or water bottle.",
    stock: 100,
  },
  {
    id: "full-send",
    name: "Full Send Energy",
    category: "Cars & bikes",
    price: 10,
    originalPrice: 79,
    images: [
      "/assets/sticker-set-cars.jpg",
      "/assets/sticker-set-cars-detail-3.jpg",
      "/assets/sticker-set-cars-detail-1.jpg",
    ],
    background: "mint",
    tag: "On the go",
    rating: "4.8",
    ratingCount: 164,
    description:
      "All throttle, no brakes. A bold little badge for people who commit first and think about it on the next straight.",
    stock: 85,
  },
  {
    id: "chai-first",
    name: "Chai First, Everything Later",
    category: "Desi & culture",
    price: 10,
    originalPrice: 79,
    images: [
      "/assets/sticker-set-desi.jpg",
      "/assets/sticker-set-desi-detail-1.jpg",
      "/assets/sticker-set-desi-detail-2.jpg",
    ],
    background: "coral",
    tag: "Desi favourite",
    rating: "4.9",
    ratingCount: 302,
    description:
      "Some things can wait. Chai cannot. Stick this on the bottle you carry to every 4pm break and let everyone know your priorities.",
    stock: 120,
  },
  {
    id: "auto-pilot",
    name: "Auto Pilot",
    category: "Desi & culture",
    price: 10,
    originalPrice: 79,
    images: [
      "/assets/sticker-set-desi.jpg",
      "/assets/sticker-set-desi-detail-3.jpg",
      "/assets/sticker-set-desi-detail-1.jpg",
    ],
    background: "lemon",
    tag: "Little icon",
    rating: "4.8",
    ratingCount: 96,
    description:
      "Let the day drive itself. A tiny steering-wheel energy for your desk, dashboard or the diary you keep forgetting to open.",
    stock: 50,
  },
  {
    id: "tiny-ghost",
    name: "Tiny Ghost, Big Plans",
    category: "Good vibes",
    price: 10,
    originalPrice: 79,
    images: [
      "/assets/sticker-set-mood.jpg",
      "/assets/sticker-set-mood-detail-1.jpg",
      "/assets/sticker-set-mood-detail-2.jpg",
    ],
    background: "mint",
    tag: "Mood booster",
    rating: "4.9",
    ratingCount: 184,
    description:
      "Quietly haunting your to-do list with good intentions. A soft, friendly die-cut that will not judge how long that spreadsheet has been open.",
    stock: 90,
  },
  {
    id: "overthinking-club",
    name: "Overthinking Club Member",
    category: "Good vibes",
    price: 10,
    originalPrice: 79,
    images: [
      "/assets/sticker-set-mood.jpg",
      "/assets/sticker-set-mood-detail-3.jpg",
      "/assets/sticker-set-mood-detail-1.jpg",
    ],
    background: "lemon",
    tag: "Relatable",
    rating: "4.7",
    ratingCount: 241,
    description:
      "Lifetime membership, no initiation fee. Wear your mental tabs like a badge of honour on your laptop cover.",
    stock: 150,
  },
];
