import { LogEntry, CreateLogInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
}

export class LogService {
  private db: D1Database;

  constructor(env: Env) {
    this.db = env.DB;
  }

  async createLog(data: CreateLogInput): Promise<LogEntry> {
    const result = await this.db
      .prepare(
        `INSERT INTO Logs (log_type, http_status, url, description) VALUES (?, ?, ?, ?)`
      )
      .bind(data.log_type, data.http_status || null, data.url || null, data.description || null)
      .run();

    return (await this.db
      .prepare('SELECT * FROM Logs WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<LogEntry>())!;
  }

  async getLogs(
    page: number = 1,
    limit: number = 20,
    logType?: string
  ): Promise<{ data: LogEntry[]; total: number }> {
    let query = 'SELECT * FROM Logs';
    let countQuery = 'SELECT COUNT(*) as count FROM Logs';
    const params: any[] = [];

    if (logType) {
      const where = ' WHERE log_type = ?';
      query += where;
      countQuery += where;
      params.push(logType);
    }

    const countResult = await this.db
      .prepare(countQuery)
      .bind(...params)
      .first<{ count: number }>();

    const offset = (page - 1) * limit;
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const results = await this.db
      .prepare(query)
      .bind(...params, limit, offset)
      .all<LogEntry>();

    return {
      data: results.results || [],
      total: countResult?.count || 0,
    };
  }

  async getById(id: number): Promise<LogEntry | null> {
    return await this.db
      .prepare('SELECT * FROM Logs WHERE id = ?')
      .bind(id)
      .first<LogEntry>() || null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM Logs WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  async logRequest(url: string, httpStatus: number, description?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO Logs (log_type, http_status, url, description) VALUES ('request', ?, ?, ?)`
      )
      .bind(httpStatus, url, description || null)
      .run();
  }
}
