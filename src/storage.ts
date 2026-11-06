import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { config, isR2Configured } from "./config.js";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });
  }
  return client;
}

const ALLOWED = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

/**
 * Upload an image buffer to R2 and return its public URL.
 * Throws if R2 is not configured or the content type is unsupported.
 */
export async function uploadImage(
  buffer: Buffer,
  contentType: string
): Promise<string> {
  if (!isR2Configured) {
    throw new Error(
      "Image storage is not configured. Set the R2_* environment variables, or paste an image URL instead."
    );
  }

  const ext = ALLOWED.get(contentType);
  if (!ext) {
    throw new Error("Unsupported image type. Use JPG, PNG, WEBP or GIF.");
  }

  const key = `products/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const base = config.r2.publicBaseUrl.replace(/\/$/, "");
  return `${base}/${key}`;
}
