import { getImage , uploadImage} from "./route/image";
import { handleUserRoutes } from "./routes/users";
import { handlePostRoutes } from "./routes/posts";
import { handleImageResizeQueue, ImageResizeMessage } from "./queues/imageResizeConsumer";
import { handleVectorizeRoutes } from "./routes/vectorize";
import { handleProductRoutes } from "./routes/products";
import { handleDocumentRoutes } from "./routes/documents";
import { handleProductPOCRoutes } from "./routes/productPOC";
import { handleBookingRoutes } from "./routes/bookings";
import { handleLogRoutes } from "./routes/logs";
import { handleFileRoutes } from "./routes/files";
import { LogService } from "./services/LogService";

interface Env {
  MY_BUCKET: R2Bucket;
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  R2_DOMAIN: string;
  JWT_SECRET?: string;
  IMAGE_RESIZE_QUEUE: Queue<ImageResizeMessage>;
  PRODUCTS_POC_INDEX: VectorizeIndex;
  BOOKINGS_INDEX: VectorizeIndex;
  AI: Ai;
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

	// Vectorize API Routes
	const vectorizeResponse = await handleVectorizeRoutes(request, env, url, method);
	if (vectorizeResponse) {
		return vectorizeResponse;
	}

	// Products API Routes
	const productsResponse = await handleProductRoutes(request, env, url, method);
	if (productsResponse) {
		return productsResponse;
	}

	// Documents API Routes
	const documentsResponse = await handleDocumentRoutes(request, env, url, method);
	if (documentsResponse) {
		return documentsResponse;
	}

	// ProductPOC API Routes
	const productPOCResponse = await handleProductPOCRoutes(request, env, url, method);
	if (productPOCResponse) {
		return productPOCResponse;
	}

	// Bookings API Routes
	const bookingsResponse = await handleBookingRoutes(request, env, url, method);
	if (bookingsResponse) {
		return bookingsResponse;
	}

	// Logs API Routes
	const logsResponse = await handleLogRoutes(request, env, url, method);
	if (logsResponse) {
		return logsResponse;
	}

	// Files API Routes
	const filesResponse = await handleFileRoutes(request, env, url, method);
	if (filesResponse) {
		return filesResponse;
	}

	// Request Logging - บันทึกทุก request ที่ไม่ match route ใดๆ
	const logService = new LogService(env);
	ctx.waitUntil(
		logService.logRequest(url.pathname, 404, `${method} ${url.pathname} - Not Found`)
	);

		return Response.json({ error: "Not Found" }, { status: 404 });
	},

	/**
	 * Queue Consumer Handler
	 * จัดการ messages จาก Image Resize Queue
	 */
	async queue(batch: MessageBatch<ImageResizeMessage>, env: Env): Promise<void> {
		await handleImageResizeQueue(batch, env);
	},
} satisfies ExportedHandler<Env>;
