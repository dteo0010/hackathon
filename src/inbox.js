/**
 * JS port of the organisers' loader.py - same interface for both data options:
 *   new Inbox('data')                   extracted static bundle folder
 *   new Inbox('http://localhost:8080')  the organisers' Docker server
 *
 * readBytes() on a file that doesn't exist throws an error with
 * code 'ENOENT' (folder) or status 404 (server); the runner treats both as
 * "attachment missing".
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export class Inbox {
  constructor(source) {
    this.source = String(source).replace(/\/+$/, '');
    this.isRemote = /^https?:\/\//i.test(this.source);
  }

  async emails() {
    if (this.isRemote) return this.#getJson('/emails');
    const dir = path.join(this.source, 'inbox');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
  }

  async get(emailId) {
    if (this.isRemote) return this.#getJson(`/emails/${encodeURIComponent(emailId)}`);
    return JSON.parse(await readFile(path.join(this.source, 'inbox', `${emailId}.json`), 'utf8'));
  }

  /** Raw bytes of an attachment; attPath exactly as in email.attachments. */
  async readBytes(attPath) {
    if (this.isRemote) {
      const res = await fetch(this.source + '/' + attPath.replace(/^\/+/, ''));
      if (!res.ok) throw httpError(res, attPath);
      return Buffer.from(await res.arrayBuffer());
    }
    const full = path.resolve(this.source, attPath);
    if (!full.startsWith(path.resolve(this.source))) throw new Error(`attachment path escapes data folder: ${attPath}`);
    return readFile(full);
  }

  async readText(attPath) {
    return (await this.readBytes(attPath)).toString('utf8');
  }

  async sampleSubmission() {
    if (this.isRemote) return this.#getJson('/sample_submission');
    return JSON.parse(await readFile(path.join(this.source, 'sample_submission.json'), 'utf8'));
  }

  /** POST a submission for self-evaluation. Server only. */
  async submit(submission) {
    if (!this.isRemote) {
      throw Object.assign(new Error('Scoring needs the organisers\' server (PIPELINE_DATA=http://localhost:8080).'), { status: 400 });
    }
    const res = await fetch(this.source + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
    });
    if (!res.ok) throw httpError(res, '/submit');
    return res.json();
  }

  async #getJson(p) {
    const res = await fetch(this.source + p);
    if (!res.ok) throw httpError(res, p);
    return res.json();
  }
}

function httpError(res, what) {
  const err = new Error(`HTTP ${res.status} for ${what}`);
  err.status = res.status;
  return err;
}
