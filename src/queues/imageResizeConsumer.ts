/**
 * Image Resize Queue Consumer
 * รับ message จาก Queue และทำการ resize รูปภาพ
 */

import { createImageVariants, getResizedFilename, ResizeTask } from '../utils/imageProcessor';

interface Env {
  MY_BUCKET: R2Bucket;
  DB: D1Database;
  R2_DOMAIN: string;
}

export interface ImageResizeMessage {
  userId: number;
  originalFilename: string;
  contentType: string;
  timestamp: number;
}

/**
 * Queue Consumer Handler
 * ประมวลผล batch ของ messages จาก Queue
 */
export async function handleImageResizeQueue(
  batch: MessageBatch<ImageResizeMessage>,
  env: Env
): Promise<void> {
  console.log(`[Queue] Processing ${batch.messages.length} image resize tasks`);

  // ประมวลผลแต่ละ message
  for (const message of batch.messages) {
    try {
      await processImageResize(message.body, env);

      // Acknowledge message เมื่อประมวลผลสำเร็จ
      message.ack();

      console.log(`[Queue] ✅ Successfully processed image for user ${message.body.userId}`);
    } catch (error) {
      console.error(`[Queue] ❌ Failed to process image for user ${message.body.userId}:`, error);

      // Retry message (ไม่ ack) - Queue จะส่ง message กลับมาอีกครั้ง
      message.retry();
    }
  }
}

/**
 * ประมวลผลการ resize รูปภาพจาก message
 */
async function processImageResize(
  message: ImageResizeMessage,
  env: Env
): Promise<void> {
  const { userId, originalFilename, contentType } = message;

  console.log(`[Queue] Starting resize for user ${userId}, file: ${originalFilename}`);

  // ดึงไฟล์ต้นฉบับจาก R2
  const originalImage = await env.MY_BUCKET.get(originalFilename);

  if (!originalImage) {
    throw new Error(`Original image not found: ${originalFilename}`);
  }

  const imageBuffer = await originalImage.arrayBuffer();

  // สร้าง resize task configuration
  const resizeTask: ResizeTask = {
    userId,
    originalFilename,
    contentType,
    sizes: {
      thumbnail: {
        width: 150,
        height: 150,
        fit: 'cover',
        quality: 85,
      },
      medium: {
        width: 400,
        height: 400,
        fit: 'scale-down',
        quality: 90,
      },
      large: {
        width: 1024,
        height: 1024,
        fit: 'scale-down',
        quality: 90,
      },
    },
  };

  // สร้าง variants ของรูปภาพ (thumbnail, medium, large)
  console.log(`[Queue] Creating image variants...`);
  const variants = await createImageVariants(imageBuffer, resizeTask);

  // Upload variants กลับไปที่ R2
  const uploadPromises = [];

  // Upload thumbnail
  const thumbnailFilename = getResizedFilename(userId, 'thumbnail', originalFilename);
  uploadPromises.push(
    env.MY_BUCKET.put(thumbnailFilename, variants.thumbnail, {
      httpMetadata: { contentType },
    })
  );

  // Upload medium
  const mediumFilename = getResizedFilename(userId, 'medium', originalFilename);
  uploadPromises.push(
    env.MY_BUCKET.put(mediumFilename, variants.medium, {
      httpMetadata: { contentType },
    })
  );

  // Upload large
  const largeFilename = getResizedFilename(userId, 'large', originalFilename);
  uploadPromises.push(
    env.MY_BUCKET.put(largeFilename, variants.large, {
      httpMetadata: { contentType },
    })
  );

  await Promise.all(uploadPromises);

  console.log(`[Queue] Uploaded all variants to R2`);

  // อัพเดท database ด้วย URLs ของรูปภาพที่ resize แล้ว
  const r2Domain = env.R2_DOMAIN || 'https://cdn.example.com';
  const thumbnailUrl = `${r2Domain}/${thumbnailFilename}`;
  const mediumUrl = `${r2Domain}/${mediumFilename}`;
  const largeUrl = `${r2Domain}/${largeFilename}`;

  // อัพเดท metadata ใน database (สามารถเพิ่ม column ใหม่สำหรับเก็บ URLs ของแต่ละ size)
  // ในตัวอย่างนี้ เราจะใช้ JSON column หรือสร้าง table ใหม่
  await env.DB.prepare(
    `UPDATE users
     SET updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(userId)
    .run();

  console.log(`[Queue] ✅ Image resize completed for user ${userId}`);
  console.log(`  - Thumbnail: ${thumbnailUrl}`);
  console.log(`  - Medium: ${mediumUrl}`);
  console.log(`  - Large: ${largeUrl}`);
}
