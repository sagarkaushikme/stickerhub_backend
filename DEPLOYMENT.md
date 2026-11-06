# StickerHub — Production Deployment Runbook

Deploy order matters: **backend first** (it gets a public URL), then the **shop** and **admin** (they point at that URL), then **DNS** and **Razorpay webhook**.

Target domains:
- `stickerhub.in` → storefront (shop)
- `api.stickerhub.in` → backend API
- `admin.stickerhub.in` → admin panel

---

## 0. Prerequisites

- [ ] Neon database is live (you already have `DATABASE_URL`).
- [ ] Resend domain `stickerhub.in` verified (done).
- [ ] A GitHub repo for the code (recommended for Railway + Cloudflare auto-deploys).
- [ ] Access to `stickerhub.in` DNS.

> Before pushing to GitHub, confirm `.gitignore` is in place in every folder so `.env` never gets committed. (Already added.)

---

## 1. Deploy the backend (Railway)

Railway runs the Dockerfile in `sticker_backend/`.

1. Go to railway.app → **New Project** → **Deploy from GitHub repo** → pick the repo, set the **root directory** to `sticker_backend`.
2. Railway detects the `Dockerfile` automatically.
3. Under **Variables**, add every key from `.env` (values from your local `.env`):
   - `NODE_ENV=production`
   - `PORT=4000`
   - `DATABASE_URL=...`
   - `JWT_ACCESS_SECRET=...`
   - `JWT_REFRESH_SECRET=...`
   - `ADMIN_KEY=...` (your strong key)
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL=orders@stickerhub.in`, `RESEND_FROM_NAME=StickerHub`, `RESEND_REPLY_TO=support@stickerhub.in`
   - `SHOP_URL=https://stickerhub.in`
   - `CLIENT_URL=https://stickerhub.in`
   - `ALLOWED_ORIGINS=https://stickerhub.in,https://admin.stickerhub.in`
   - (optional, for image upload) `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`
4. Deploy. Railway gives you a URL like `https://stickerhub-backend-production.up.railway.app`.
5. **Add custom domain** `api.stickerhub.in` in Railway → it gives you a CNAME to add in DNS (see step 4).
6. Verify: open `https://api.stickerhub.in/api/health` → should return `{"status":"ok","db":"connected",...}`.

> The backend refuses to boot in production if `ADMIN_KEY`, JWT secrets, `DATABASE_URL`, or the Razorpay secret are missing/default. If it won't start, check the deploy logs for "Refusing to start".

**Alternative hosts:** Render (New → Web Service → Docker), Fly.io (`fly launch`). Same env vars.

---

## 2. Deploy the shop (Cloudflare Workers)

The shop builds to a Cloudflare Workers bundle via nitro.

1. In Cloudflare dashboard → **Workers & Pages** → connect the GitHub repo, root directory `sticker-shop`.
2. Build command: `npm run build`. The deploy uses the generated `.output/server/wrangler.json`.
   - Or deploy from your machine: `cd sticker-shop && npm run build && npx wrangler deploy`
3. Set the build-time env var **`VITE_API_URL=https://api.stickerhub.in/api`** in the Cloudflare project settings.
4. Add custom domain `stickerhub.in` (and `www.stickerhub.in` → redirect to apex) in the Worker's settings.
5. Verify: visit `https://stickerhub.in` → shop loads, shows "new drops coming soon" until you add products.

---

## 3. Deploy the admin (Cloudflare Pages or Netlify)

The admin is a static Vite SPA (`sticker-admin/dist`).

1. New project → connect repo, root directory `sticker-admin`.
2. Build command: `npm run build`. Output directory: `dist`.
3. Set env vars:
   - `VITE_API_URL=https://api.stickerhub.in/api`
   - `VITE_SHOP_URL=https://stickerhub.in`
4. Add custom domain `admin.stickerhub.in`.
5. Verify: visit `https://admin.stickerhub.in` → login screen appears. Enter your `ADMIN_KEY` → dashboard loads.

---

## 4. DNS (at your domain registrar / Cloudflare DNS)

| Host | Type | Points to |
|------|------|-----------|
| `@` (stickerhub.in) | per Cloudflare Worker instructions | shop Worker |
| `www` | CNAME | apex (redirect) |
| `api` | CNAME | Railway-provided target |
| `admin` | CNAME | Cloudflare Pages / Netlify target |
| (Resend records) | MX / TXT | already added for email |

Wait for DNS to propagate (minutes to a couple of hours). Each platform shows a green "active/verified" when ready.

---

## 5. Razorpay live webhook

1. Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**.
2. URL: `https://api.stickerhub.in/api/webhooks/razorpay`
3. Secret: must equal your `RAZORPAY_WEBHOOK_SECRET` env value.
4. Events: `payment.captured`, `order.paid`, `payment.failed`.
5. Save.

---

## 6. Post-deploy checks

- [ ] `https://api.stickerhub.in/api/health` → ok
- [ ] Shop loads at `https://stickerhub.in`, no CORS errors in console
- [ ] Admin login works at `https://admin.stickerhub.in`
- [ ] Add a test product in admin → it appears on the shop
- [ ] Place a small real order → confirmation email arrives, order shows in admin
- [ ] Mark the order SHIPPED in admin → shipped email arrives
- [ ] Submit `https://stickerhub.in/sitemap.xml` in Google Search Console

---

## Notes

- `support@stickerhub.in` must be a real mailbox (set up forwarding at your email provider) so customer replies don't bounce. Resend only sends, it does not receive.
- Rotate `ADMIN_KEY` any time by changing the env var on the backend; everyone re-enters it at the admin login.
- To clear leftover demo data in the live DB, delete the demo products from the admin Products tab (or run a one-off SQL in Neon).
