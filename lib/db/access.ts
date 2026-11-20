import type { Database } from "./client";

const queues = new WeakMap<Database, Promise<void>>();

// The local driver owns one connection. Serialize request operations so an
// overlapping read cannot borrow the connection during another transaction.
export async function withDatabase<T>(db: Database, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(db) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(db, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(db) === current) queues.delete(db);
  }
}
