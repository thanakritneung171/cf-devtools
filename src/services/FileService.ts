import { FileRecord, CreateFileInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  MY_BUCKET: R2Bucket;
  R2_DOMAIN?: string;
}

export class FileService {
  private db: D1Database;
  private bucket: R2Bucket;
  private r2Domain: string;

  constructor(env: Env) {
    this.db = env.DB;
    this.bucket = env.MY_BUCKET;
    this.r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
  }

  async uploadFile(file: File, uploadedBy?: number): Promise<FileRecord> {
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `files/${timestamp}-${safeName}`;

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await this.bucket.put(filePath, arrayBuffer, {
      httpMetadata: { contentType: file.type },
    });

    // Determine file_type category
    let fileType = 'other';
    if (file.type.startsWith('image/')) fileType = 'image';
    else if (file.type === 'application/pdf') fileType = 'pdf';
    else if (file.type.startsWith('text/')) fileType = 'text';

    // Save metadata to D1
    const result = await this.db
      .prepare(
        `INSERT INTO files (file_name, file_path, file_type, uploaded_by) VALUES (?, ?, ?, ?)`
      )
      .bind(file.name, filePath, fileType, uploadedBy || null)
      .run();

    return (await this.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<FileRecord>())!;
  }

  async getFiles(page: number = 1, limit: number = 20): Promise<{ data: (FileRecord & { url: string })[]; total: number }> {
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as count FROM files')
      .first<{ count: number }>();

    const offset = (page - 1) * limit;
    const results = await this.db
      .prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all<FileRecord>();

    const data = (results.results || []).map(f => ({
      ...f,
      url: `${this.r2Domain}/${f.file_path}`,
    }));

    return {
      data,
      total: countResult?.count || 0,
    };
  }

  async getById(id: number): Promise<(FileRecord & { url: string }) | null> {
    const file = await this.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .bind(id)
      .first<FileRecord>();

    if (!file) return null;
    return { ...file, url: `${this.r2Domain}/${file.file_path}` };
  }

  async downloadFile(id: number): Promise<{ object: R2ObjectBody; file: FileRecord } | null> {
    const file = await this.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .bind(id)
      .first<FileRecord>();

    if (!file) return null;

    const object = await this.bucket.get(file.file_path);
    if (!object) return null;

    return { object, file };
  }

  async deleteFile(id: number): Promise<boolean> {
    const file = await this.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .bind(id)
      .first<FileRecord>();

    if (!file) return false;

    // Delete from R2
    await this.bucket.delete(file.file_path);

    // Delete from D1
    await this.db
      .prepare('DELETE FROM files WHERE id = ?')
      .bind(id)
      .run();

    return true;
  }
}
