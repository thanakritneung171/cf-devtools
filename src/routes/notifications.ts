/**
 * Notification Routes
 *
 * GET  /api/notifications/ws?user_id=xxx  — เชื่อมต่อ WebSocket (frontend ใช้)
 * POST /api/notifications/push            — push notification ให้ user (internal / admin)
 *
 * Frontend example:
 *   const ws = new WebSocket("wss://your-domain.com/api/notifications/ws?user_id=123");
 *   ws.onmessage = (e) => {
 *     const data = JSON.parse(e.data);
 *     if (data.type === "queue_status_changed") alert(data.message);
 *   };
 */
export async function handleNotificationRoutes(
  request: Request,
  env: any,
  url: URL,
  method: string
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/notifications')) return null;

  // GET /api/notifications/ws?user_id=xxx — WebSocket connection สำหรับ frontend
  if (url.pathname === '/api/notifications/ws' && method === 'GET') {
    const userId = url.searchParams.get('user_id');

    if (!userId) {
      return Response.json({ error: 'Missing user_id' }, { status: 400 });
    }

    if (!env.NOTIFICATION_DO) {
      return Response.json({ error: 'NOTIFICATION_DO binding not found' }, { status: 500 });
    }

    const id = env.NOTIFICATION_DO.idFromName(userId);
    const stub = env.NOTIFICATION_DO.get(id);

    // Forward request พร้อม Upgrade header ไปยัง DO
    return stub.fetch(new Request('https://notification-do/ws', {
      headers: request.headers,
    }));
  }

  // POST /api/notifications/push — push notification ไปยัง user ที่ระบุ
  // Body: { user_id: number, type: string, message: string, ...payload }
  if (url.pathname === '/api/notifications/push' && method === 'POST') {
    try {
      const body: any = await request.json();
      const { user_id, ...payload } = body;

      if (!user_id) {
        return Response.json({ error: 'Missing user_id' }, { status: 400 });
      }

      if (!env.NOTIFICATION_DO) {
        return Response.json({ error: 'NOTIFICATION_DO binding not found' }, { status: 500 });
      }

      const id = env.NOTIFICATION_DO.idFromName(user_id.toString());
      const stub = env.NOTIFICATION_DO.get(id);

      return stub.fetch('https://notification-do/push', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
