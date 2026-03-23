export class R2LogService {

  constructor(private bucket: R2Bucket) {}

  async readLogs(): Promise<any[]> {

    // ==========================================================
    // List ไฟล์ 7 วันย้อนหลัง
    // R2 naming: logpush/20240115/xxx.gz
    // list ทุก prefix พร้อมกันใน 1 รอบ
    // ==========================================================

    const now = new Date();
    const prefixes: string[] = [];

    for (let i = 0; i < 2; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      prefixes.push(`logpush/${this.datePrefix(d)}/`);
    }

    console.log("[R2] Listing prefixes:", prefixes);

    // list ทุก prefix พร้อมกัน
    const listResults = await Promise.all(prefixes.map(p => this.listPrefix(p)));
    let allObjects = listResults.flat();

    // fallback — ถ้าไม่เจอไฟล์เลย อ่าน logpush/ ทั้งหมด
    if (allObjects.length === 0) {
      console.log("[R2] No files found by date prefix, fallback to full list");
      allObjects = await this.listPrefix("logpush/");
    }

    // กรองเฉพาะ .gz และ .json
    const files = allObjects.filter(
      o => o.key.endsWith(".gz") || o.key.endsWith(".json")
    );

    console.log("[R2] Total files to read:", files.length);

    // ==========================================================
    // Parallel fetch ทีละ batch 10 ไฟล์
    // ไม่จำกัดจำนวนไฟล์ เพื่อให้ครบ 7 วัน
    // ==========================================================

    const BATCH_SIZE = 10;
    const logs: any[] = [];

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch   = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(obj => this.readFile(obj.key)));
      for (const lines of results) {
        logs.push(...lines);
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
        try { lines.push(JSON.parse(line)); } catch {}
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

}