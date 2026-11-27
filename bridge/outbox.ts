import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Sent } from './link.ts';
// The images and files of drafts that go out as the owner (see Messages), kept in a directory of the control plane's state from the moment
// the agent drafts them until the draft is sent or not sent, when they are removed. The agent's machine reads them when the draft is made,
// so that the card shows what really goes out; the client of the owner's machine gets them only when the owner clicks 发送. Next to them is
// what of each send already went out (see Progress): open-lark sends a file once per request, so a retry after a partial failure has to
// skip what went out. Everything here is 0600 in a 0700 directory.

// What of the send under one delivery key already went out: the text, once sent, and the open-lark message id of each image or file by its id
// (null for a file whose message open-lark did not name).
export type Progress = { text?: Sent; attachments: Record<string, string | null> };
// Ids are UUIDs that Bridge made, so no id can name a path outside the directory.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checked = (id: string) => {
  if (!uuid.test(id)) throw Error('附件 ID 无效：' + id);
  return id;
};
// The outbox in directory dir, which it creates.
export class Outbox {
  declare dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Keeps bytes under a new id and returns the id.
  put(bytes: Uint8Array): string {
    const id = randomUUID();
    fs.writeFileSync(path.join(this.dir, id), bytes, { mode: 0o600, flag: 'wx' });
    return id;
  }
  // The bytes kept under id; throws when they are gone.
  read(id: string): Buffer {
    try {
      return fs.readFileSync(path.join(this.dir, checked(id)));
    } catch (e) {
      throw e?.code === 'ENOENT' ? Error('附件的内容已经不在 Bridge 上了，请 Agent 重新起草') : e;
    }
  }
  // What of the send under key already went out; nothing when it has not started.
  progress(key: string): Progress {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, checked(key) + '.json'), 'utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT') return { attachments: {} };
      throw e;
    }
  }
  // Records progress p of the send under key; the file is replaced in one rename, so a crash leaves the old record or the new one.
  record(key: string, p: Progress) {
    const file = path.join(this.dir, checked(key) + '.json'),
      temporary = file + '.' + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(p), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  // Removes the bytes of ids and the progress of keys; what is gone already is fine.
  remove(ids: string[], keys: string[] = []) {
    for (const name of [...ids.map(checked), ...keys.map((k) => checked(k) + '.json')])
      fs.rmSync(path.join(this.dir, name), { force: true });
  }
}
