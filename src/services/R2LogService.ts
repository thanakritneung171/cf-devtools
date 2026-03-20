export class R2LogService {

  constructor(private bucket: R2Bucket) {}

  async readLogs(): Promise<any[]> {

    const logs: any[] = [];
    let cursor: string | undefined;
    let fileCount = 0;

    do {

      const result = await this.bucket.list({
        prefix: "logpush/",
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });

      // R2 list ใช้ result.truncated + result.cursor สำหรับ pagination
      cursor = result.truncated ? (result as any).cursor : undefined;

      for (const obj of result.objects) {

        if (!obj.key.endsWith(".gz") && !obj.key.endsWith(".json")) {
          continue;
        }

        try {

          const file = await this.bucket.get(obj.key);
          if (!file || !file.body) continue;

          let text = "";

          if (obj.key.endsWith(".gz")) {
            const ds = new DecompressionStream("gzip");
            const decompressed = file.body.pipeThrough(ds);
            text = await new Response(decompressed).text();
          } else {
            text = await new Response(file.body).text();
          }

          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              logs.push(JSON.parse(line));
            } catch {}
          }

          fileCount++;

          // Debug: ดู structure ของ log entry จริงๆ จาก file แรก
          if (fileCount === 1 && logs.length > 0) {
            console.log("[R2] Sample keys:", Object.keys(logs[0]));
            console.log("[R2] Sample entry:", JSON.stringify(logs[0]).slice(0, 600));
          }

        } catch (err) {
          console.error("[R2] Error reading:", obj.key, err);
        }

      }

    } while (cursor);

    console.log("[R2] Files:", fileCount, "| Lines:", logs.length);
    return logs;

  }

}