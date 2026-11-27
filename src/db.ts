import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export interface FileRecord {
  id: string
  ext: string
  filename: string
  mime_type: string
  size: number
  sha256: string
  tg_chat_id: string
  tg_message_id: number
  tg_file_id: string | null
  enc_salt: string
  enc_iv: string
  mgmt_token_hash: string
  created_at: number
  downloads: number
}

export type NewFileRecord = Omit<FileRecord, 'downloads'>

export class FileDatabase {
  private readonly db: Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.initSchema()
  }

  private initSchema(): void {
    const existingCols = this.db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>
    if (existingCols.length > 0 && !existingCols.some((c) => c.name === 'enc_iv')) {
      this.db.exec('DROP TABLE files;')
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        ext TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        tg_chat_id TEXT NOT NULL,
        tg_message_id INTEGER NOT NULL,
        tg_file_id TEXT,
        enc_salt TEXT NOT NULL,
        enc_iv TEXT NOT NULL,
        mgmt_token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
      CREATE INDEX IF NOT EXISTS idx_files_tg_msg ON files(tg_chat_id, tg_message_id);
    `)
  }

  insert(record: NewFileRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO files (
        id, ext, filename, mime_type, size, sha256,
        tg_chat_id, tg_message_id, tg_file_id,
        enc_salt, enc_iv,
        mgmt_token_hash, created_at, downloads
      ) VALUES (
        $id, $ext, $filename, $mime_type, $size, $sha256,
        $tg_chat_id, $tg_message_id, $tg_file_id,
        $enc_salt, $enc_iv,
        $mgmt_token_hash, $created_at, 0
      )
    `)
    stmt.run({
      $id: record.id,
      $ext: record.ext,
      $filename: record.filename,
      $mime_type: record.mime_type,
      $size: record.size,
      $sha256: record.sha256,
      $tg_chat_id: record.tg_chat_id,
      $tg_message_id: record.tg_message_id,
      $tg_file_id: record.tg_file_id,
      $enc_salt: record.enc_salt,
      $enc_iv: record.enc_iv,
      $mgmt_token_hash: record.mgmt_token_hash,
      $created_at: record.created_at,
    })
  }

  getById(id: string): FileRecord | null {
    const stmt = this.db.prepare('SELECT * FROM files WHERE id = ? LIMIT 1')
    return (stmt.get(id) as FileRecord | null) ?? null
  }

  findExistingBySha256(
    sha256: string
  ): Pick<FileRecord, 'tg_chat_id' | 'tg_message_id' | 'tg_file_id' | 'enc_salt' | 'enc_iv'> | null {
    const stmt = this.db.prepare(`
      SELECT tg_chat_id, tg_message_id, tg_file_id, enc_salt, enc_iv
      FROM files
      WHERE sha256 = ? AND enc_salt != '' AND enc_iv != ''
      ORDER BY created_at DESC
      LIMIT 1
    `)
    return (
      (stmt.get(sha256) as Pick<
        FileRecord,
        'tg_chat_id' | 'tg_message_id' | 'tg_file_id' | 'enc_salt' | 'enc_iv'
      > | null) ?? null
    )
  }

  countByTelegramMessage(tgChatId: string, tgMessageId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM files
      WHERE tg_chat_id = ? AND tg_message_id = ?
    `)
    const row = stmt.get(tgChatId, tgMessageId) as { cnt: number } | null
    return row?.cnt ?? 0
  }

  updateTgFileId(tgChatId: string, tgMessageId: number, tgFileId: string): void {
    const stmt = this.db.prepare(`
      UPDATE files
      SET tg_file_id = ?
      WHERE tg_chat_id = ? AND tg_message_id = ?
    `)
    stmt.run(tgFileId, tgChatId, tgMessageId)
  }

  incrementDownloads(id: string): void {
    const stmt = this.db.prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?')
    stmt.run(id)
  }

  deleteById(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM files WHERE id = ?')
    const info = stmt.run(id)
    return info.changes > 0
  }

  getStats(): { count: number; totalBytes: number } {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS totalBytes
      FROM files
    `)
    const row = stmt.get() as { count: number; totalBytes: number } | null
    return {
      count: row?.count ?? 0,
      totalBytes: row?.totalBytes ?? 0,
    }
  }

  close(): void {
    this.db.close()
  }
}
