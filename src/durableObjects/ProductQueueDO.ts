export class ProductQueueDO {

  state: DurableObjectState
  env: any
  ACTIVE_LIMIT = 2

  constructor(state: DurableObjectState, env: any) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request) {

    const url = new URL(request.url)
    const method = request.method

    if (url.pathname.endsWith("/join") && method === 'POST') {

      const body = await request.json()
      const userId = body.userId
      const productId = body.productId

      const active = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'
      `).bind(productId).first()

      let status = "WAITING"

      if (active.count < this.ACTIVE_LIMIT) {
        status = "ACTIVE"
      }

      await this.env.DB.prepare(`
        INSERT INTO product_queue (product_id,user_id,status,created_at) VALUES (?,?,?,datetime('now', '+7 hours'))
      `)
      .bind(productId,userId,status)
      .run()

      // get current row
      const current = await this.env.DB.prepare(`
        SELECT id FROM product_queue WHERE product_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1
      `).bind(productId, userId).first()

      // position
      const position = await this.env.DB.prepare(`
        SELECT COUNT(*) as pos FROM product_queue WHERE product_id = ? AND id <= ?
      `)
      .bind(productId, current.id)
      .first()

      return Response.json({
        status,
        position: position.pos
      })
    }

    if (url.pathname === "/queue/status" && method === 'GET') {

      const productId = url.searchParams.get("productId")
      const userId = url.searchParams.get("userId")

      if (!productId || !userId) {
        return new Response("Missing productId or userId", { status: 400 })
      }

      console.log("Checking status for productId:", productId, "userId:", userId)

      //รวม queue ทั้งหมด
      const allQueueResult = await this.env.DB.prepare(`
        SELECT user_id
        FROM product_queue
        WHERE product_id = ?
        AND status IN ('ACTIVE', 'WAITING')
        ORDER BY created_at
      `).bind(productId).all()

      const queue = allQueueResult.results

      // หา position
      const index = queue.findIndex(q => q.user_id === userId)

      let position = null
      let peopleAhead = null
      let total = queue.length

      if (index !== -1) {
        position = index + 1
        peopleAhead = index
      }

      return Response.json({
        inQueue: index !== -1,
        position,
        peopleAhead,
        total
      })
    }

    if (url.pathname.endsWith("/leave") && method === 'POST') {

      const body = await request.json()
      const userId = body.userId
      const productId = body.productId

      // remove user
      await this.env.DB.prepare(`
        DELETE FROM product_queue
        WHERE id = (
          SELECT id FROM product_queue WHERE user_id = ? AND product_id = ? ORDER BY created_at LIMIT 1
        )
      `).bind(userId, productId).run()

      // check active count
      const activeCount = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'
      `).bind(productId).first()

      if (activeCount.count < 2) { // สมมุติ limit = 2

        const next = await this.env.DB.prepare(`
          SELECT id FROM product_queue WHERE product_id = ? AND status = 'WAITING' ORDER BY created_at LIMIT 1
        `).bind(productId).first()

        if (next) {
          await this.env.DB.prepare(`
            UPDATE product_queue SET status = 'ACTIVE' WHERE id = ?
          `).bind(next.id).run()
        }
      }

      return Response.json({
        message: "left queue"
      })
    }

    return new Response("Not Found", { status: 404 })
  }
}