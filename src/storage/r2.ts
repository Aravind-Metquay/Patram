import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export function objectKeyForJob(jobId: string): string {
  return `pdf/${jobId}.pdf`;
}

export async function uploadPdf(objectKey: string, buffer: Buffer): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: objectKey,
      Body: buffer,
      ContentType: "application/pdf",
    }),
  );
}

export async function downloadPdf(objectKey: string): Promise<Buffer> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: objectKey }),
  );
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`Object ${objectKey} has no body`);
  }
  return Buffer.from(bytes);
}

export async function getPdfUrl(objectKey: string): Promise<string> {
  if (env.R2_PUBLIC_BASE_URL) {
    return `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${objectKey}`;
  }
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: objectKey }),
    { expiresIn: 3600 },
  );
}
