// The windows of routing and the notes handed to topics in them, in butler's store. A window is a fixed stretch of time,
// by when butler stored each message: from where the last window ended up to its end. A routing agent works one window
// (see route-round.mjs) and hands each live topic at most one note about the window's messages (see route-tools.mjs).

const DAY = 86_400_000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS route_windows(
 id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, from_at INTEGER NOT NULL, from_id TEXT, until_at INTEGER NOT NULL,
 state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, reply TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS routed(
 id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, topic_id TEXT NOT NULL, topic_title TEXT NOT NULL, message_ids TEXT NOT NULL,
 text TEXT NOT NULL, status TEXT NOT NULL, run_ids TEXT NOT NULL, sent_at INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS routed_by_topic ON routed(topic_id,id);
CREATE INDEX IF NOT EXISTS routed_pending ON routed(id) WHERE status='pending';`;
// The old router's rows have no window and were never previews.
const ADDED_COLUMNS = [
  ['routed', 'window_id', 'INTEGER'],
  ['routed', 'preview', 'INTEGER NOT NULL DEFAULT 0'],
];
// Made after the columns it needs, which an old routed table gains on open.
const ONE_NOTE_PER_TOPIC =
  'CREATE UNIQUE INDEX IF NOT EXISTS routed_once ON routed(window_id,topic_id) WHERE window_id IS NOT NULL';
// Where the next window starts. The old router kept its cursor here too, so the first window starts where it ended.
const CURSOR = 'routing';

// The messages of a window that may be news to a topic. Left out: what Bridge's bot and butler's bot sent (their own
// output), the owner's messages in a Bridge topic thread (Bridge gives those to that topic), and history sent more than a
// day before butler stored it (a group just joined). A window starts after from_at, or at from_at after from_id, which
// only the old router's cursor has. The bound on created_at follows from the day rule and lets the scan use its index.
const WINDOW_MESSAGES = `
SELECT m.id FROM messages m
WHERE (m.first_seen_at > $fromAt OR (m.first_seen_at = $fromAt AND m.id > $fromId))
  AND m.first_seen_at <= $untilAt
  AND m.created_at >= $fromAt - ${DAY}
  AND m.created_at >= m.first_seen_at - ${DAY}
  AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT value FROM json_each($bots)))
  AND NOT (m.is_mine = 1 AND m.root_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM messages root WHERE root.id = m.root_id AND root.sender_id = $bridgeBot)
    OR EXISTS (SELECT 1 FROM messages reply WHERE reply.root_id = m.root_id AND reply.sender_id = $bridgeBot)))
ORDER BY m.created_at, m.id`;

// The Bridge key of the note of a window for a topic: Bridge takes it once, so a retried window cannot hand a topic its
// note twice. Distinct from the old router's keys (butler-route:<row>).
export const noteKey = (windowId, topicId) => `butler-route:w${windowId}:${topicId}`;

function windowOf(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    mode: row.mode,
    from: { at: row.from_at, id: row.from_id },
    until: row.until_at,
    state: row.state,
    attempts: row.attempts,
    error: row.error ?? undefined,
    reply: row.reply ?? undefined,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function noteOf(row) {
  return {
    id: row.id,
    at: row.at,
    windowId: row.window_id ?? undefined,
    preview: Boolean(row.preview),
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    messageIds: JSON.parse(row.message_ids),
    text: row.text,
    status: row.status,
    sentAt: row.sent_at ?? undefined,
    error: row.error ?? undefined,
    ...(row.window_id && { key: noteKey(row.window_id, row.topic_id) }),
  };
}

export class RouteWindows {
  // bridgeBotId and ownBotId: Bridge's bot and butler's bot as open-lark knows them; the listing needs them, the log does not.
  constructor(store, { bridgeBotId, ownBotId, now = Date.now } = {}) {
    this.store = store;
    this.db = store.db;
    this.bridgeBotId = bridgeBotId;
    this.ownBotId = ownBotId;
    this.now = now;
    this.db.exec(SCHEMA);
    this.#addColumns();
    this.db.exec(ONE_NOTE_PER_TOPIC);
  }

  #addColumns() {
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  #transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Where the next window starts, {at, id}, or undefined before the first.
  cursor() {
    return this.store.meta(CURSOR)?.cursor;
  }

  // Moves the start of the next window past at, for a stretch that needs no window (nothing new, or no live topic).
  passOver(at) {
    this.store.setMeta(CURSOR, { cursor: { at, id: null } });
  }

  // A window over messages stored after from ({at, id}) up to until. mode: dry-run or on for the timer's windows, which
  // move the cursor with them; preview for a window run by hand, which leaves the cursor alone.
  create({ from, until, mode }) {
    return this.#transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO route_windows(mode,from_at,from_id,until_at,state,created_at) VALUES(?,?,?,?,'open',?)")
        .run(mode, from.at, from.id ?? null, until, this.now());
      if (mode !== 'preview') this.passOver(until);
      return this.window(Number(lastInsertRowid));
    });
  }

  window(id) {
    return windowOf(this.db.prepare('SELECT * FROM route_windows WHERE id=?').get(id));
  }

  // The timer's window that is not done yet: its agent failed or was cut off, and it is run again as it is.
  openWindow() {
    const row = this.db
      .prepare("SELECT * FROM route_windows WHERE state='open' AND mode<>'preview' ORDER BY id LIMIT 1")
      .get();
    return windowOf(row);
  }

  finish(id, reply) {
    this.db
      .prepare("UPDATE route_windows SET state='done',reply=?,error=NULL,finished_at=? WHERE id=?")
      .run(reply ?? null, this.now(), id);
    return this.window(id);
  }

  // Counts a failed run of the window's agent; after maxAttempts the window is skipped. Returns the window.
  fail(id, error, maxAttempts) {
    const { attempts } = this.window(id);
    const state = attempts + 1 >= maxAttempts ? 'skipped' : 'open';
    const finishedAt = state === 'skipped' ? this.now() : null;
    this.db
      .prepare('UPDATE route_windows SET attempts=?,error=?,state=?,finished_at=? WHERE id=?')
      .run(attempts + 1, error, state, finishedAt, id);
    return this.window(id);
  }

  // The window's messages as store records, oldest first. span: a window, or {from, until} before there is one.
  messages(span) {
    const bots = [this.bridgeBotId, this.ownBotId].filter(Boolean);
    const rows = this.db.prepare(WINDOW_MESSAGES).all({
      fromAt: span.from.at,
      fromId: span.from.id ?? null,
      untilAt: span.until,
      bots: JSON.stringify(bots),
      bridgeBot: this.bridgeBotId ?? null,
    });
    return rows.map((row) => this.store.message(row.id));
  }

  // Keeps a note of window for a topic; returns it, or undefined when the window already holds a note for that topic.
  addNote({ window, topicId, topicTitle, messageIds, text, status }) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO routed(at,topic_id,topic_title,message_ids,text,status,run_ids,window_id,preview) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    const preview = window.mode === 'preview' ? 1 : 0;
    const { changes, lastInsertRowid } = insert.run(
      this.now(),
      topicId,
      topicTitle,
      JSON.stringify(messageIds),
      text,
      status,
      '[]',
      window.id,
      preview,
    );
    if (!changes) return undefined;
    return this.note(Number(lastInsertRowid));
  }

  note(id) {
    return noteOf(this.db.prepare('SELECT * FROM routed WHERE id=?').get(id));
  }

  noteFor(windowId, topicId) {
    const row = this.db.prepare('SELECT * FROM routed WHERE window_id=? AND topic_id=?').get(windowId, topicId);
    return row && noteOf(row);
  }

  // After a hand-over: given (sentAt), dropped for good (error), or still pending (error of the last try).
  setNoteStatus(id, { status, error }) {
    const sentAt = status === 'given' ? this.now() : null;
    this.db.prepare('UPDATE routed SET status=?,error=?,sent_at=? WHERE id=?').run(status, error ?? null, sentAt, id);
    return this.note(id);
  }

  pendingNotes() {
    const rows = this.db.prepare("SELECT * FROM routed WHERE status='pending' ORDER BY id").all();
    return rows.map(noteOf);
  }

  notesOf(windowId) {
    return this.db.prepare('SELECT * FROM routed WHERE window_id=? ORDER BY id').all(windowId).map(noteOf);
  }

  // What butler gave a topic lately, newest last: only notes Bridge took or is yet to take. A dry run's or a preview's
  // note (dry) and one Bridge refused (dropped) never reached the topic, and an agent shown them as given would take them
  // for what the topic already knows.
  recentNotes(topicId, limit) {
    const rows = this.db
      .prepare("SELECT * FROM routed WHERE topic_id=? AND status IN ('given','pending') ORDER BY id DESC LIMIT ?")
      .all(topicId, limit);
    return rows.reverse().map(noteOf);
  }

  // The windows created since, newest first, at most limit of the timer's and of previews each, with their notes; and the
  // old router's notes since, which have no window.
  log({ since, limit }) {
    const windowsOf = (previews) => {
      const rows = this.db
        .prepare(`SELECT * FROM route_windows WHERE created_at>=? AND (mode='preview')=? ORDER BY id DESC LIMIT ?`)
        .all(since, previews ? 1 : 0, limit);
      return rows.map((row) => ({ ...windowOf(row), notes: this.notesOf(row.id) }));
    };
    const earlier = this.db
      .prepare('SELECT * FROM routed WHERE window_id IS NULL AND at>=? ORDER BY id DESC LIMIT ?')
      .all(since, limit)
      .map(noteOf);
    return { windows: windowsOf(false), previews: windowsOf(true), earlier };
  }
}
