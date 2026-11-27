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
  enc_salt: string
  enc_iv: string
  mgmt_token_hash: string
  created_at: number
  downloads: number
}

export type NewFileRecord = Omit<FileRecord, 'downloads'>

export interface FilePartRecord {
  file_id: string
  part_index: number
  byte_offset: number
  byte_length: number
  tg_chat_id: string
  tg_message_id: number
  tg_file_id: string | null
}

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        ext TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        enc_salt TEXT NOT NULL,
        enc_iv TEXT NOT NULL,
        mgmt_token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS file_parts (
        file_id TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        tg_chat_id TEXT NOT NULL,
        tg_message_id INTEGER NOT NULL,
        tg_file_id TEXT,
        PRIMARY KEY (file_id, part_index)
      );

      CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
      CREATE INDEX IF NOT EXISTS idx_file_parts_tg_msg ON file_parts(tg_chat_id, tg_message_id);
    `)
  }

  insertWithParts(record: NewFileRecord, parts: FilePartRecord[]): void {
    const insertFile = this.db.prepare(`
      INSERT INTO files (
        id, ext, filename, mime_type, size, sha256,
        enc_salt, enc_iv,
        mgmt_token_hash, created_at, downloads
      ) VALUES (
        $id, $ext, $filename, $mime_type, $size, $sha256,
        $enc_salt, $enc_iv,
        $mgmt_token_hash, $created_at, 0
      )
    `)
    const insertPart = this.db.prepare(`
      INSERT INTO file_parts (
        file_id, part_index, byte_offset, byte_length,
        tg_chat_id, tg_message_id, tg_file_id
      ) VALUES (
        $file_id, $part_index, $byte_offset, $byte_length,
        $tg_chat_id, $tg_message_id, $tg_file_id
      )
    `)

    const tx = this.db.transaction(() => {
      insertFile.run({
        $id: record.id,
        $ext: record.ext,
        $filename: record.filename,
        $mime_type: record.mime_type,
        $size: record.size,
        $sha256: record.sha256,
        $enc_salt: record.enc_salt,
        $enc_iv: record.enc_iv,
        $mgmt_token_hash: record.mgmt_token_hash,
        $created_at: record.created_at,
      })

      for (const part of parts) {
        insertPart.run({
          $file_id: part.file_id,
          $part_index: part.part_index,
          $byte_offset: part.byte_offset,
          $byte_length: part.byte_length,
          $tg_chat_id: part.tg_chat_id,
          $tg_message_id: part.tg_message_id,
          $tg_file_id: part.tg_file_id,
        })
      }
    })
    tx()
  }

  getById(id: string): FileRecord | null {
    const stmt = this.db.prepare('SELECT * FROM files WHERE id = ? LIMIT 1')
    return (stmt.get(id) as FileRecord | null) ?? null
  }

  getParts(fileId: string): FilePartRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM file_parts
      WHERE file_id = ?
      ORDER BY part_index ASC
    `)
    return stmt.all(fileId) as FilePartRecord[]
  }

  findExistingBySha256(
    sha256: string
  ): { enc_salt: string; enc_iv: string; parts: FilePartRecord[] } | null {
    const stmt = this.db.prepare(`
      SELECT id, enc_salt, enc_iv
      FROM files
      WHERE sha256 = ? AND enc_salt != '' AND enc_iv != ''
      ORDER BY created_at DESC
      LIMIT 1
    `)
    const row = stmt.get(sha256) as Pick<FileRecord, 'id' | 'enc_salt' | 'enc_iv'> | null
    if (!row) return null
    const parts = this.getParts(row.id)
    if (parts.length === 0) return null
    return {
      enc_salt: row.enc_salt,
      enc_iv: row.enc_iv,
      parts,
    }
  }

  countByTelegramMessage(tgChatId: string, tgMessageId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM file_parts
      WHERE tg_chat_id = ? AND tg_message_id = ?
    `)
    const row = stmt.get(tgChatId, tgMessageId) as { cnt: number } | null
    return row?.cnt ?? 0
  }

  updateTgFileId(tgChatId: string, tgMessageId: number, tgFileId: string): void {
    const stmt = this.db.prepare(`
      UPDATE file_parts
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
    const delParts = this.db.prepare('DELETE FROM file_parts WHERE file_id = ?')
    const delFile = this.db.prepare('DELETE FROM files WHERE id = ?')
    const tx = this.db.transaction(() => {
      delParts.run(id)
      const info = delFile.run(id)
      return info.changes > 0
    })
    return tx()
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
