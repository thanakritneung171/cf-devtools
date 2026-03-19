export class R2LogService {

  constructor(private bucket: R2Bucket) {}

  async readLogs(): Promise<any[]> {

    const logs:any[] = [];
    let cursor: string | undefined;

    do {

      const result = await this.bucket.list({
        prefix: "logpush/",
        cursor
      });

      cursor = result.truncated ? result.cursor : undefined;

      for (const obj of result.objects) {

        if (!obj.key.endsWith(".gz") && !obj.key.endsWith(".json")) continue;

        const file = await this.bucket.get(obj.key);
        if (!file || !file.body) continue;

        let text = "";

        try {

          if (obj.key.endsWith(".gz")) {

            const ds = new DecompressionStream("gzip");
            const decompressed = file.body.pipeThrough(ds);
            text = await new Response(decompressed).text();

          } else {

            text = await new Response(file.body).text();

          }

        } catch {
          continue;
        }

        const lines = text.split("\n");

        for (const line of lines) {

          if (!line.trim()) continue;

          try {
            logs.push(JSON.parse(line));
          } catch {}

        }

      }

    } while (cursor);

    console.log("Total logs:", logs.length);

    return logs;

  }

}