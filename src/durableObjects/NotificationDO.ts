/**
 * NotificationDO — Durable Object สำหรับ real-time WebSocket notification per user
 * แต่ละ instance ตรงกับ user_id หนึ่งคน
 *
 * หลักการ:
 *   - ถ้า frontend online  → ส่ง notification ทันทีผ่าน WebSocket
 *   - ถ้า frontend offline → เก็บลง inbox (DO storage) ไว้ก่อน
 *   - เมื่อ frontend connect → flush inbox ออกมาทันที แล้วล้าง inbox
 *
 * Endpoints:
 *   GET  /ws   — WebSocket upgrade (frontend ใช้)
 *   POST /push — ส่ง notification (backend ใช้)
 */

interface InboxMessage {
  id: string;
  payload: object;
  created_at: string;
}

const INBOX_KEY    = 'inbox';
const INBOX_LIMIT  = 50; // เก็บสูงสุด 50 ข้อความ ป้องกัน storage บวม

export class NotificationDO {
  state: DurableObjectState;
  env: any;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env   = env;
  }

  // ===== Inbox helpers =====

  private async getInbox(): Promise<InboxMessage[]> {
    return (await this.state.storage.get<InboxMessage[]>(INBOX_KEY)) ?? [];
  }

  private async saveInbox(inbox: InboxMessage[]): Promise<void> {
    await this.state.storage.put(INBOX_KEY, inbox);
  }

  private async addToInbox(payload: object): Promise<void> {
    const inbox = await this.getInbox();
    inbox.push({
      id:         crypto.randomUUID(),
      payload,
      created_at: new Date().toISOString(),
    });
    // ตัดทิ้งถ้าเกิน limit (เก็บแค่ล่าสุด)
    const trimmed = inbox.length > INBOX_LIMIT ? inbox.slice(-INBOX_LIMIT) : inbox;
    await this.saveInbox(trimmed);
  }

  private async flushInbox(ws: WebSocket): Promise<void> {
    const inbox = await this.getInbox();
    if (inbox.length === 0) return;

    for (const msg of inbox) {
      try {
        ws.send(JSON.stringify({
          ...msg.payload,
          _inbox: true,           // บอก frontend ว่ามาจาก inbox (missed notification)
          _inbox_id:         msg.id,
          _inbox_created_at: msg.created_at,
        }));
      } catch {
        // ถ้าส่งไม่ได้ให้หยุด (WebSocket อาจปิดระหว่าง flush)
        return;
      }
    }

    await this.saveInbox([]); // ล้าง inbox หลัง flush สำเร็จ
  }

  // ===== fetch handler =====

  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method;

    // GET /ws — WebSocket upgrade + flush inbox ทันทีที่ connect
    if (url.pathname.endsWith('/ws')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair             = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // รับ WebSocket connection ก่อน (Hibernatable API)
      this.state.acceptWebSocket(server);

      // flush inbox ทันทีที่ frontend connect — ส่ง missed notifications ทุกอัน
      await this.flushInbox(server);

      return new Response(null, {
        status:    101,
        webSocket: client,
      });
    }

    // POST /push — ส่ง notification
    if (url.pathname.endsWith('/push') && method === 'POST') {
      const payload = await request.json() as object;
      const message = JSON.stringify(payload);

      const sockets = this.state.getWebSockets();
      let sent = 0;
      for (const ws of sockets) {
        try {
          ws.send(message);
          sent++;
        } catch {
          // WebSocket ปิดแล้ว — ข้ามไป
        }
      }

      // ถ้าไม่มีใคร connect อยู่ → เก็บลง inbox รอ flush ทีหลัง
      if (sent === 0) {
        await this.addToInbox(payload);
      }

      return Response.json({
        sent,
        queued:          sent === 0,
        total_connected: sockets.length,
      });
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  // ===== Hibernatable WebSocket handlers =====

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string);
      if (data.action === 'ping') {
        ws.send(JSON.stringify({ action: 'pong', ts: Date.now() }));
      }
    } catch {
      // ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, 'WebSocket error');
  }
}
