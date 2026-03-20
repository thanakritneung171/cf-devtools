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
import { getTicketQueueTestPage } from "./pages/ticketQueueTestPage";
import { LogService } from "./services/LogService";
export { TicketQueueDO } from "./durableObjects/TicketQueueDO";
export { TicketQueueDOTest } from "./durableObjects/TicketQueueDOTest";
import { dashboardHandler } from "./routes/dashboard";
import { dashboardTopIP } from "./routes/dashboardTopIP";
import { dashboardErrors } from "./routes/dashboardErrors";
import { handleDashboardBookingsRoutes } from "./routes/dashboardBookings";

declare global {
  interface Env {
     IMAGE_RESIZE_QUEUE: Queue<ImageResizeMessage>;
	  
  }
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
	const url = new URL(request.url);
    const method = request.method;
	
	
	  // CORS
	  if (request.method === "OPTIONS") {
	   return new Response(null, {
		headers:{
		 "Access-Control-Allow-Origin":"*",
		 "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
		 "Access-Control-Allow-Headers":"*"
		}
	   });
	  }
	
	  const cors=(res:Response)=>{
	   const headers=new Headers(res.headers);
	   headers.set("Access-Control-Allow-Origin","*");
	   headers.set("Access-Control-Allow-Methods","GET,POST,OPTIONS");
	   headers.set("Access-Control-Allow-Headers","*");
	
	   return new Response(res.body,{
		status:res.status,
		headers
	   });
	  };
	
	  if(url.pathname==="/api/dashboard"){
	   return cors(await dashboardHandler(request,env));
	  }
	
	  if(url.pathname==="/api/dashboard/top-ip"){
	   return cors(await dashboardTopIP(request,env));
	  }
	
	  if(url.pathname==="/api/dashboard/errors"){
	   return cors(await dashboardErrors(request,env));
	   
	  }
	
	  //return new Response("Not Found",{status:404});
	

// GET /
    if (url.pathname === "/" && method === "GET") {
      return Response.json({ message: "Hello Worker API 🚀" });
    }

    // GET /ticket-queue-test — HTML test page
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

	// Bookings Dashboard API Routes
	const dashboardBookingsResponse = await handleDashboardBookingsRoutes(request, env, url, method);
	if (dashboardBookingsResponse) {
		return dashboardBookingsResponse;
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

	
	 // join queue
    if (url.pathname === "/queue/join" && request.method === "POST") {

		const body = await request.json()

		const productId = body.productId

		const id = env.PRODUCT_QUEUE.idFromName(productId.toString())

		const stub = env.PRODUCT_QUEUE.get(id)

		return stub.fetch("https://queue/join", {
		method: "POST",
		body: JSON.stringify(body)
		})

    }

	// leave queue
    if (url.pathname === "/queue/leave" && request.method === "POST") {

		const body = await request.json()

		const productId = body.productId

		const id = env.PRODUCT_QUEUE.idFromName(productId.toString())

		const stub = env.PRODUCT_QUEUE.get(id)

		return stub.fetch("https://queue/leave", {
		method: "POST",
		body: JSON.stringify(body)
		})

    }

	if (url.pathname.startsWith("/queue")) {

		const productId = url.searchParams.get("productId")

		if (!productId) {
			return new Response("Missing productId", { status: 400 })
		}

		const id = env.PRODUCT_QUEUE.idFromName(productId.toString())
		const stub = env.PRODUCT_QUEUE.get(id)

		console.log("เข้า index route แล้ว:", url.pathname, "productId:", productId)

		return stub.fetch(request)
	}
	// Ticket Queue API Routes (Durable Object)
	const ticketQueueResponse = await handleTicketQueueRoutes(request, env, url, method);
	if (ticketQueueResponse) {
		return ticketQueueResponse;
	}

	// Ticket Queue Test API Routes (DO Storage version)
	const ticketQueueTestResponse = await handleTicketQueueTestRoutes(request, env, url, method);
	if (ticketQueueTestResponse) {
		return ticketQueueTestResponse;
	}

	// Product Queue API Routes
	const productQueueResponse = await handleProductQueueRoutes(request, env, url, method);
	if (productQueueResponse) {
		return productQueueResponse;
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
	async queue(batch, env, _ctx): Promise<void> {
		await handleImageResizeQueue(batch as MessageBatch<ImageResizeMessage>, env);
	},
} satisfies ExportedHandler<Env>;
