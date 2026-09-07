/**
 * Versioned schema + migrations.
 *
 * Every migration bumps `schema_version`. Migrations run inside one transaction each, so a
 * failure leaves the database on the previous version.
 *
 * Notes on a couple of choices:
 *  - `messages.seq` is an INTEGER PRIMARY KEY (a stable rowid alias) so the FTS5 index can key
 *    off it; `messages.id` is the UUID everything else refers to.
 *  - Hot list columns live in `messages`; html/text/headers live in `message_bodies` so list
 *    queries never touch big blobs.
 *  - `messages_fts` is contentless with `contentless_delete=1` where supported (SQLite >= 3.43),
 *    which keeps the index small; a plain FTS5 table is used as a fallback. Rows are synced
 *    explicitly on upsert/setMessageBody, plus an AFTER DELETE trigger for cascades.
 */
import { log } from './log'
import type { SqlDatabase } from './sqlite'

export const SCHEMA_VERSION = 2

interface Migration {
  version: number
  name: string
  up(db: SqlDatabase): void
}

function createFtsTable(db: SqlDatabase): void {
  if (!db.fts5) {
    log.warn('FTS5 is not available in this SQLite build — search will fall back to LIKE scans')
    return
  }
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
         subject, sender, recipients, body,
         content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
       )`
    )
  } catch (err) {
    log.warn('contentless_delete FTS5 table unavailable, using a content-storing table —', (err as Error)?.message)
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
         subject, sender, recipients, body,
         tokenize='unicode61 remove_diacritics 2'
       )`
    )
  }
  // Cascade deletes (folder removal, account removal) must clean the index too.
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS messages_after_delete AFTER DELETE ON messages BEGIN
       DELETE FROM messages_fts WHERE rowid = old.seq;
     END`
  )
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL,
          auth_type TEXT NOT NULL,
          imap_host TEXT NOT NULL DEFAULT '',
          imap_port INTEGER NOT NULL DEFAULT 993,
          imap_secure INTEGER NOT NULL DEFAULT 1,
          smtp_host TEXT NOT NULL DEFAULT '',
          smtp_port INTEGER NOT NULL DEFAULT 465,
          smtp_secure INTEGER NOT NULL DEFAULT 1,
          username TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#3b82f6',
          signature TEXT,
          created_at INTEGER NOT NULL,
          last_sync_at INTEGER,
          last_error TEXT,
          cache_limit INTEGER NOT NULL DEFAULT 5000,
          enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          secret_enc BLOB,
          oauth_enc BLOB
        );

        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          delimiter TEXT NOT NULL DEFAULT '/',
          kind TEXT NOT NULL DEFAULT 'custom',
          unread_count INTEGER NOT NULL DEFAULT 0,
          total_count INTEGER NOT NULL DEFAULT 0,
          synced INTEGER NOT NULL DEFAULT 1,
          UNIQUE (account_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_folders_account_kind ON folders (account_id, kind);

        CREATE TABLE IF NOT EXISTS folder_sync_state (
          folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
          uid_validity INTEGER,
          uid_next INTEGER,
          highest_modseq TEXT,
          lowest_uid INTEGER,
          last_full_flag_sync_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          gm_thrid TEXT,
          subject TEXT NOT NULL DEFAULT '',
          subject_norm TEXT NOT NULL DEFAULT '',
          last_date INTEGER NOT NULL DEFAULT 0,
          first_date INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          unread_count INTEGER NOT NULL DEFAULT 0,
          has_starred INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          has_draft INTEGER NOT NULL DEFAULT 0,
          participants_json TEXT NOT NULL DEFAULT '[]',
          snippet TEXT NOT NULL DEFAULT '',
          folder_kinds_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_threads_last_date ON threads (last_date DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_threads_account_date ON threads (account_id, last_date DESC);
        CREATE INDEX IF NOT EXISTS idx_threads_gm_thrid ON threads (account_id, gm_thrid);
        CREATE INDEX IF NOT EXISTS idx_threads_subject ON threads (account_id, subject_norm, last_date);

        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          uid INTEGER NOT NULL,
          message_id_header TEXT,
          in_reply_to TEXT,
          references_json TEXT NOT NULL DEFAULT '[]',
          gm_thrid TEXT,
          gm_msgid TEXT,
          subject TEXT NOT NULL DEFAULT '',
          subject_norm TEXT NOT NULL DEFAULT '',
          from_json TEXT NOT NULL DEFAULT '[]',
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          reply_to_json TEXT NOT NULL DEFAULT '[]',
          date INTEGER NOT NULL DEFAULT 0,
          internal_date INTEGER,
          snippet TEXT NOT NULL DEFAULT '',
          seen INTEGER NOT NULL DEFAULT 0,
          flagged INTEGER NOT NULL DEFAULT 0,
          answered INTEGER NOT NULL DEFAULT 0,
          draft INTEGER NOT NULL DEFAULT 0,
          forwarded INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          size INTEGER NOT NULL DEFAULT 0,
          labels_json TEXT NOT NULL DEFAULT '[]',
          body_fetched INTEGER NOT NULL DEFAULT 0,
          participants_norm TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT 0,
          UNIQUE (folder_id, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, date);
        CREATE INDEX IF NOT EXISTS idx_messages_account_date ON messages (account_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_header_id ON messages (message_id_header);
        CREATE INDEX IF NOT EXISTS idx_messages_account_header_id ON messages (account_id, message_id_header);
        CREATE INDEX IF NOT EXISTS idx_messages_gm_thrid ON messages (account_id, gm_thrid);
        CREATE INDEX IF NOT EXISTS idx_messages_in_reply_to ON messages (account_id, in_reply_to);
        CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages (folder_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_body_pending ON messages (folder_id, body_fetched, date DESC);

        CREATE TABLE IF NOT EXISTS message_bodies (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          html TEXT,
          text TEXT,
          headers_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          filename TEXT NOT NULL DEFAULT '',
          content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          size INTEGER NOT NULL DEFAULT 0,
          content_id TEXT,
          is_inline INTEGER NOT NULL DEFAULT 0,
          part_id TEXT NOT NULL DEFAULT '',
          local_path TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

        CREATE TABLE IF NOT EXISTS pending_actions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          request_json TEXT NOT NULL,
          targets_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_account ON pending_actions (account_id, created_at);

        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          status TEXT NOT NULL DEFAULT 'queued'
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_account ON outbox (account_id, created_at);

        CREATE TABLE IF NOT EXISTS drafts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          remote_uid INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_drafts_account ON drafts (account_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contacts (
          address TEXT PRIMARY KEY,
          name TEXT,
          count INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_count ON contacts (count DESC, last_seen DESC);
      `)
      createFtsTable(db)
    }
  },
  {
    version: 2,
    name: 'gmail all-mail dedupe',
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_account_gm_msgid ON messages (account_id, gm_msgid)')
      // Gmail's "[Gmail]/All Mail" mirrors every other folder. Earlier builds stored that mirror as a
      // second row per message, so every thread showed each email twice. Keep the copy that lives in a
      // real folder and drop the All Mail duplicate; the store now refuses to create new ones.
      db.exec(`
        DELETE FROM messages WHERE id IN (
          SELECT a.id FROM messages a
          JOIN folders fa ON fa.id = a.folder_id
          WHERE fa.kind = 'all' AND a.gm_msgid IS NOT NULL AND EXISTS (
            SELECT 1 FROM messages b
            JOIN folders fb ON fb.id = b.folder_id
            WHERE b.account_id = a.account_id AND b.gm_msgid = a.gm_msgid
              AND b.folder_id <> a.folder_id AND fb.kind <> 'all'
          )
        )
      `)
    }
  }
]

/** Current schema version stored in the database (0 when empty). */
export function currentVersion(db: SqlDatabase): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`
  )
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get<{ v: number | null }>()
  return Number(row?.v ?? 0)
}

/** Run every migration newer than the stored version. Returns the resulting version. */
export function migrate(db: SqlDatabase): number {
  let version = currentVersion(db)
  for (const migration of migrations) {
    if (migration.version <= version) continue
    log.info(`applying migration ${migration.version} (${migration.name})`)
    db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now()
      )
    })()
    version = migration.version
  }
  return version
}

/** True when the FTS index exists and can be queried. */
export function hasFts(db: SqlDatabase): boolean {
  if (!db.fts5) return false
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get<{ name: string }>()
  return !!row
}
