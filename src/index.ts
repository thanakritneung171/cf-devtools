import { getImage , uploadImage} from "./route/image";
import { handleUserRoutes } from "./routes/users";
import { handleVectorizeRoutes } from "./routes/vectorize";
import { handleProductRoutes } from "./routes/products";
import { handleDocumentRoutes } from "./routes/documents";

interface Env {
  MY_BUCKET: R2Bucket;
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  VECTORIZE: VectorizeIndex;
  PRODUCTS_INDEX: VectorizeIndex;
  AI: Ai;
  R2_DOMAIN: "https://pub-5996ee0506414893a70d525a21960eba.r2.dev";
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

		return new Response("Hello Worker!");
	},
} satisfies ExportedHandler<Env>;
