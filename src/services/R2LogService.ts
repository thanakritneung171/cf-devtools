export class R2LogService {

  constructor(private bucket: R2Bucket) {}

  async readLogs(): Promise<any[]> {

    const logs:any[] = [];
    let cursor: string | undefined;

    do {

      const result = await this.bucket.list({
        prefix: "logpush/",
        limit: 1000,
        cursor
      });

      cursor = result.truncated ? result.cursor : undefined;

      for (const obj of result.objects) {

        if (!obj.key.endsWith(".gz") && !obj.key.endsWith(".json")) {
          continue;
        }

        try {

          const file = await this.bucket.get(obj.key);
          if (!file || !file.body) continue;

          let text = "";

          // decompress gzip
          if (obj.key.endsWith(".gz")) {

            const ds = new DecompressionStream("gzip");
            const decompressed = file.body.pipeThrough(ds);
            text = await new Response(decompressed).text();

          } else {

            text = await new Response(file.body).text();

          }

          const lines = text.split("\n");

          for (const line of lines) {

            if (!line.trim()) continue;

            try {
              logs.push(JSON.parse(line));
            } catch {}

          }

        } catch (err) {

          console.log("Error reading:", obj.key);

        }

      }

    } while (cursor);

    console.log("Total logs read:", logs.length);

    return logs;

  }

}