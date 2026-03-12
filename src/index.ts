import { getImage , uploadImage} from "./route/image";
import { handleUserRoutes } from "./routes/users";
import { handlePostRoutes } from "./routes/posts";
import { handleImageResizeQueue, ImageResizeMessage } from "./queues/imageResizeConsumer";

interface Env {
  MY_BUCKET: R2Bucket;
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  R2_DOMAIN: string;
  IMAGE_RESIZE_QUEUE: Queue<ImageResizeMessage>;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
	const url = new URL(request.url);
    const method = request.method;

// GET /
    if (url.pathname === "/" && method === "GET") {
      return Response.json({ message: "Hello Worker API 🚀" });
    }

    // GET /api/hello
    if (url.pathname === "/api/hello" && method === "GET") {
      const name = url.searchParams.get("name") || "Guest";
      return Response.json({ greeting: `Hello ${name}` });
    }

    // POST /api/echo
    if (url.pathname === "/api/echo" && method === "POST") {
      const body = await request.json();
      return Response.json({
        you_sent: body,
      });
    }

    // GET /api/time
    if (url.pathname === "/api/time" && method === "GET") {
      return Response.json({
        now: new Date().toISOString(),
      });
    }

	// GET /api/image
    if (url.pathname === "/api/image" && method === "GET") {
      return getImage(request, env);
    }
	
	 // Upload
    if (url.pathname === "/api/upload" && method === "POST") {
      return uploadImage(request, env);
    }

	// User API Routes
	const userResponse = await handleUserRoutes(request, env, url, method);
	if (userResponse) {
		return userResponse;
	}

	// Posts API Routes
	if (url.pathname.startsWith('/api/posts')) {
		return await handlePostRoutes(request, env);
	}

		return new Response("Hello Worker!");
	},

	/**
	 * Queue Consumer Handler
	 * จัดการ messages จาก Image Resize Queue
	 */
	async queue(batch: MessageBatch<ImageResizeMessage>, env: Env): Promise<void> {
		await handleImageResizeQueue(batch, env);
	},
} satisfies ExportedHandler<Env>;
