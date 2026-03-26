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
import { handleProductQueueRoutes } from "./routes/productQueue";
import { handleTicketQueueRoutes } from "./routes/ticketQueue";
import { handleTicketQueueTestRoutes } from "./routes/ticketQueueTest";
import { handleNotificationRoutes } from "./routes/notifications";
import { getTicketQueueTestPage } from "./pages/ticketQueueTestPage";
import { LogService } from "./services/LogService";
export { TicketQueueDO } from "./durableObjects/TicketQueueDO";
export { TicketQueueDOTest } from "./durableObjects/TicketQueueDOTest";
export { NotificationDO } from "./durableObjects/NotificationDO";
import { dashboardHandler } from "./routes/dashboard";
import { dashboardTopIP } from "./routes/dashboardTopIP";
import { dashboardErrors } from "./routes/dashboardErrors";
import { handleDashboardBookingsRoutes } from "./routes/dashboardBookings";

declare global {
  interface Env {
     IMAGE_RESIZE_QUEUE: Queue<ImageResizeMessage>;
  }
}

// ==========================================================
// Helper: log error ให้ Logpush เก็บใน Logs field
// เรียกผ่าน ctx.waitUntil เพื่อไม่ delay response
// ==========================================================
async function logErrorResponse(request: Request, response: Response): Promise<void> {
  try {
    const body = await response.clone().text();
    console.error(JSON.stringify({
      status:  response.status,
      method:  request.method,
      url:     request.url,
      message: body.slice(0, 300),
    }));
  } catch {
    console.error(JSON.stringify({
      status: response.status,
      method: request.method,
      url:    request.url,
    }));
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const cors = (res: Response) => {
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin",  "*");
      headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      headers.set("Access-Control-Allow-Headers", "*");
      return new Response(res.body, { status: res.status, headers });
    };

    // Dashboard routes — ไม่ผ่าน error logger
    if (url.pathname === "/api/dashboard") {
      return cors(await dashboardHandler(request, env));
    }
    if (url.pathname === "/api/dashboard/top-ip") {
      return cors(await dashboardTopIP(request, env));
    }
    if (url.pathname === "/api/dashboard/errors") {
      return cors(await dashboardErrors(request, env));
    }

    // ==========================================================
    // ทุก route ที่เหลือ — wrap ด้วย try/catch + error logger
    // ==========================================================

    let response: Response;

    try {
      response = await handleAllRoutes(request, env, ctx, url, method);
    } catch (err: any) {
      // Worker exception / crash → log แล้ว return 500
      console.error(JSON.stringify({
        status:  500,
        method:  request.method,
        url:     request.url,
        message: err?.message || String(err),
        stack:   err?.stack?.slice(0, 300) || "",
      }));
      response = Response.json({ error: "Internal Server Error" }, { status: 500 });
    }

    // log 4xx และ 5xx เพื่อให้ Logpush เก็บ message
    if (response.status >= 400) {
      ctx.waitUntil(logErrorResponse(request, response));
    }

    return response;
  },

  async queue(batch, env, _ctx): Promise<void> {
    await handleImageResizeQueue(batch as MessageBatch<ImageResizeMessage>, env);
  },
} satisfies ExportedHandler<Env>;

// ==========================================================
// แยก route handling ออกมาเพื่อให้ wrap try/catch ได้
// ==========================================================

async function handleAllRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  method: string
): Promise<Response> {

  // GET /
  if (url.pathname === "/" && method === "GET") {
    return Response.json({ message: "Hello Worker API 🚀" });
  }

  // GET /ticket-queue-test
  if (url.pathname === "/ticket-queue-test" && method === "GET") {
    return new Response(getTicketQueueTestPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // GET /api/hello
  if (url.pathname === "/api/hello" && method === "GET") {
    const name = url.searchParams.get("name") || "Guest";
    return Response.json({ greeting: `Hello ${name}` });
  }

  // POST /api/echo
  if (url.pathname === "/api/echo" && method === "POST") {
    const body = await request.json();
    return Response.json({ you_sent: body });
  }

  // GET /api/time
  if (url.pathname === "/api/time" && method === "GET") {
    return Response.json({
      now: new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
    });
  }

  // GET /api/image
  if (url.pathname === "/api/image" && method === "GET") {
    return getImage(request, env);
  }

  // POST /api/upload
  if (url.pathname === "/api/upload" && method === "POST") {
    return uploadImage(request, env);
  }

  // User API Routes
  const userResponse = await handleUserRoutes(request, env, url, method);
  if (userResponse) return userResponse;

  // Posts API Routes
  if (url.pathname.startsWith("/api/posts")) {
    return await handlePostRoutes(request, env);
  }

  // Vectorize API Routes
  const vectorizeResponse = await handleVectorizeRoutes(request, env, url, method);
  if (vectorizeResponse) return vectorizeResponse;

  // Products API Routes
  const productsResponse = await handleProductRoutes(request, env, url, method);
  if (productsResponse) return productsResponse;

  // Documents API Routes
  const documentsResponse = await handleDocumentRoutes(request, env, url, method);
  if (documentsResponse) return documentsResponse;

  // ProductPOC API Routes
  const productPOCResponse = await handleProductPOCRoutes(request, env, url, method);
  if (productPOCResponse) return productPOCResponse;

  // Bookings Dashboard API Routes
  const dashboardBookingsResponse = await handleDashboardBookingsRoutes(request, env, url, method);
  if (dashboardBookingsResponse) return dashboardBookingsResponse;

  // Bookings API Routes
  const bookingsResponse = await handleBookingRoutes(request, env, url, method);
  if (bookingsResponse) return bookingsResponse;

  // Logs API Routes
  const logsResponse = await handleLogRoutes(request, env, url, method);
  if (logsResponse) return logsResponse;

  // Files API Routes
  const filesResponse = await handleFileRoutes(request, env, url, method);
  if (filesResponse) return filesResponse;

  // Queue join
  if (url.pathname === "/queue/join" && request.method === "POST") {
    const body      = await request.json() as any;
    const productId = body.productId;
    const id        = env.PRODUCT_QUEUE.idFromName(productId.toString());
    const stub      = env.PRODUCT_QUEUE.get(id);
    return stub.fetch("https://queue/join", { method: "POST", body: JSON.stringify(body) });
  }

  // Queue leave
  if (url.pathname === "/queue/leave" && request.method === "POST") {
    const body      = await request.json() as any;
    const productId = body.productId;
    const id        = env.PRODUCT_QUEUE.idFromName(productId.toString());
    const stub      = env.PRODUCT_QUEUE.get(id);
    return stub.fetch("https://queue/leave", { method: "POST", body: JSON.stringify(body) });
  }

  // Queue other
  if (url.pathname.startsWith("/queue")) {
    const productId = url.searchParams.get("productId");
    if (!productId) return new Response("Missing productId", { status: 400 });
    console.log("เข้า index route แล้ว:", url.pathname, "productId:", productId);
    const id   = env.PRODUCT_QUEUE.idFromName(productId.toString());
    const stub = env.PRODUCT_QUEUE.get(id);
    return stub.fetch(request);
  }

  // Ticket Queue API Routes
  const ticketQueueResponse = await handleTicketQueueRoutes(request, env, url, method);
  if (ticketQueueResponse) return ticketQueueResponse;

  // Notification WebSocket Routes
  const notificationResponse = await handleNotificationRoutes(request, env, url, method);
  if (notificationResponse) return notificationResponse;

  // Ticket Queue Test API Routes
  const ticketQueueTestResponse = await handleTicketQueueTestRoutes(request, env, url, method);
  if (ticketQueueTestResponse) return ticketQueueTestResponse;

  // Product Queue API Routes
  const productQueueResponse = await handleProductQueueRoutes(request, env, url, method);
  if (productQueueResponse) return productQueueResponse;

  // 404
  const logService = new LogService(env);
  ctx.waitUntil(
    logService.logRequest(url.pathname, 404, `${method} ${url.pathname} - Not Found`)
  );
  return Response.json({ error: "Not Found" }, { status: 404 });
}