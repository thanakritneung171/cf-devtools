/**
 * Image Processing Utilities
 * ใช้สำหรับ resize รูปภาพด้วย Cloudflare Images Resizing API
 */

export interface ImageResizeConfig {
  width: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  quality?: number;
}

export interface ResizeTask {
  userId: number;
  originalFilename: string;
  contentType: string;
  sizes: {
    thumbnail: ImageResizeConfig;
    medium: ImageResizeConfig;
    large: ImageResizeConfig;
  };
}

/**
 * Resize image using native browser APIs (for Workers)
 * @param imageBuffer - Original image buffer
 * @param config - Resize configuration
 * @returns Resized image buffer
 */
export async function resizeImage(
  imageBuffer: ArrayBuffer,
  config: ImageResizeConfig
): Promise<ArrayBuffer> {
  // ใน Cloudflare Workers เราจะใช้ canvas-based resizing
  // หรือใช้ Cloudflare Image Resizing service
  // สำหรับตัวอย่างนี้ เราจะใช้ basic implementation

  // Note: การ resize จริงอาจต้องใช้ external library หรือ Cloudflare Image Resizing
  // ตัวอย่างนี้จะ return original buffer (placeholder)
  // ในการใช้งานจริง ควรใช้ sharp, jimp หรือ Cloudflare Image Resizing API

  return imageBuffer;
}

/**
 * สร้าง resized versions ของรูปภาพ
 * @param originalBuffer - Original image buffer
 * @param task - Resize task configuration
 * @returns Object containing all resized versions
 */
export async function createImageVariants(
  originalBuffer: ArrayBuffer,
  task: ResizeTask
): Promise<{
  thumbnail: ArrayBuffer;
  medium: ArrayBuffer;
  large: ArrayBuffer;
}> {
  const [thumbnail, medium, large] = await Promise.all([
    resizeImage(originalBuffer, task.sizes.thumbnail),
    resizeImage(originalBuffer, task.sizes.medium),
    resizeImage(originalBuffer, task.sizes.large),
  ]);

  return { thumbnail, medium, large };
}

/**
 * Generate filename for resized image
 * @param userId - User ID
 * @param size - Size variant (thumbnail, medium, large)
 * @param originalFilename - Original filename
 * @returns Generated filename
 */
export function getResizedFilename(
  userId: number,
  size: 'thumbnail' | 'medium' | 'large',
  originalFilename: string
): string {
  const timestamp = Date.now();
  const extension = originalFilename.split('.').pop() || 'jpg';
  return `users/${userId}/avatar-${size}-${timestamp}.${extension}`;
}
