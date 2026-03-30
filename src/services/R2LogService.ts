export interface ReadLogsOptions {
  from?: string;  // YYYYMMDD
  to?:   string;  // YYYYMMDD
}

export class R2LogService {

  constructor(private bucket: R2Bucket) {}

  async readLogs(options?: ReadLogsOptions): Promise<any[]> {

    // ==========================================================
    // List ไฟล์ตาม date range หรือ default 1 วัน (วันนี้)
    // R2 naming: logpush/20240115/xxx.gz
    // ==========================================================

    const now = new Date();
    const prefixes: string[] = [];

    if (options?.from || options?.to) {
      // ใช้ date range ที่ระบุ
      const fromDate = options.from ? this.parseYMD(options.from) : now;
      const toDate   = options.to   ? this.parseYMD(options.to)   : now;
      const start    = fromDate <= toDate ? fromDate : toDate;
      const end      = fromDate <= toDate ? toDate   : fromDate;

      const cursor = new Date(start);
      while (cursor <= end) {
        prefixes.push(`logpush/${this.datePrefix(cursor)}/`);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else {
      // default: วันนี้ 1 วัน
      for (let i = 0; i < 1; i++) {
        const d = new Date(now.getTime() - i * 86400000);
        prefixes.push(`logpush/${this.datePrefix(d)}/`);
      }
    }

    console.log("[R2] Listing prefixes:", prefixes);

    // list ทุก prefix พร้อมกัน
    const listResults = await Promise.all(prefixes.map(p => this.listPrefix(p)));
    let allObjects = listResults.flat();

    // ถ้าระบุ from/to แล้วไม่เจอไฟล์ → คืน array ว่าง (ไม่ fallback)
    if (allObjects.length === 0 && (options?.from || options?.to)) {
      console.log("[R2] No files found for date range, returning empty");
      return [];
    }

    // fallback — เฉพาะกรณี default (ไม่ได้ระบุ from/to)
    if (allObjects.length === 0) {
      console.log("[R2] No files found by date prefix, fallback to full list");
      // allObjects = await this.listPrefix("logpush/");
         return [];
    }

    // กรองเฉพาะ .gz และ .json
    const files = allObjects.filter(
      o => o.key.endsWith(".gz") || o.key.endsWith(".json")
    );

    console.log("[R2] Total files to read:", files.length);

    // ==========================================================
    // Parallel fetch — batch 20 ไฟล์ต่อรอบ
    // ใช้ indexed push แทน spread เพื่อกัน stack overflow กับ log เยอะ
    // ==========================================================

    const BATCH_SIZE = 20;
    const logs: any[] = [];

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch   = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(obj => this.readFile(obj.key)));
      for (const lines of results) {
        for (let j = 0, len = lines.length; j < len; j++) {
          logs.push(lines[j]);
        }
      }
    }

    console.log("[R2] Total log lines:", logs.length);

    if (logs.length > 0) {
      console.log("[R2] Sample keys:", Object.keys(logs[0]));
    }

    return logs;

  }

  // ==========================================================
  // Helper: list ทุก object ภายใต้ prefix (paginate อัตโนมัติ)
  // ==========================================================

  private async listPrefix(prefix: string): Promise<R2Object[]> {

    const objects: R2Object[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.bucket.list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      objects.push(...result.objects);
      cursor = result.truncated ? (result as any).cursor : undefined;
    } while (cursor);

    return objects;

  }

  // ==========================================================
  // Helper: อ่าน 1 ไฟล์ → คืน array of parsed log objects
  // ==========================================================

  private async readFile(key: string): Promise<any[]> {

    try {
      const file = await this.bucket.get(key);
      if (!file || !file.body) return [];

      let text = "";

      if (key.endsWith(".gz")) {
        const ds = new DecompressionStream("gzip");
        text = await new Response(file.body.pipeThrough(ds)).text();
      } else {
        text = await new Response(file.body).text();
      }

      const lines: any[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          // Logpush บางตัวเก็บข้อมูลทั้งหมดไว้ใน field "content" เป็น string
          // ต้อง parse อีกชั้นนึง
          if (parsed && typeof parsed.content === "string") {
            try {
              const inner = JSON.parse(parsed.content);
              lines.push(inner);
            } catch {
              lines.push(parsed); // content ไม่ใช่ JSON ใช้ as-is
            }
          } else {
            lines.push(parsed);
          }
        } catch {}
      }

      return lines;

    } catch (err) {
      console.error("[R2] Error reading:", key, err);
      return [];
    }

  }

  // ==========================================================
  // Helper: Date → "YYYYMMDD" ตรงกับ R2 naming ของ Logpush
  // ==========================================================

  private datePrefix(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  // ==========================================================
  // Helper: "YYYYMMDD" → Date
  // ==========================================================

  private parseYMD(ymd: string): Date {
    const y = parseInt(ymd.slice(0, 4));
    const m = parseInt(ymd.slice(4, 6)) - 1;
    const d = parseInt(ymd.slice(6, 8));
    return new Date(Date.UTC(y, m, d));
  }

}