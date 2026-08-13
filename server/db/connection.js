import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * TAWA persistence layer.
 * Dev/embedded: SQLite (WAL). SQL is written in portable relational style;
 * the same DDL targets PostgreSQL for production (see ARCHITECTURE.md §Database).
 *
 * Every transactionally-accessing helper here treats `db` as the single
 * synchronous writer; HTTP handlers are serialized per connection which is
 * correct for SQLite and harmless for a future pg driver.
 */
let singleton = null;

export function getDb(file = config.dbFile) {
  if (singleton) return singleton;
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  singleton = db;
  return singleton;
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

/** Run fn inside an IMMEDIATE transaction; rollback on throw. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export const q = {
  one(db, sql, ...params) { return db.prepare(sql).get(...params); },
  all(db, sql, ...params) { return db.prepare(sql).all(...params); },
  run(db, sql, ...params) { return db.prepare(sql).run(...params); },
};

let seq = 0;
/** Prefixed, unguessable-enough ids (time + random). Not a security boundary. */
export function id(prefix) {
  seq = (seq + 1) % 46656;
  const t = Date.now().toString(36);
  const r = (Math.random().toString(36).slice(2, 8) + seq.toString(36).padStart(3, '0')).slice(0, 9);
  return `${prefix}_${t}${r}`;
}

export const nowIso = () => new Date().toISOString();

/** Money is stored as INTEGER minor units (cents). Never float. */
export function toMinor(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}
export function toMajor(minor) {
  return (Number(minor || 0) / 100);
}
