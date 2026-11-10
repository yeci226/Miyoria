// The owner's background picture stays in this browser: it is too big for localStorage and must
// never leave the machine. IndexedDB can be missing or refuse (private windows, blocked site
// data), so every caller treats a failure as "no picture saved".

const DB = "miyoria-panel";
const STORE = "images";
const KEY = "background";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB refused"));
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  } finally {
    db.close();
  }
}

export async function loadBackgroundImage(): Promise<Blob | null> {
  const v = await run<unknown>("readonly", (s) => s.get(KEY));
  return v instanceof Blob ? v : null;
}

export async function saveBackgroundImage(image: Blob): Promise<void> {
  await run("readwrite", (s) => s.put(image, KEY));
}

export async function deleteBackgroundImage(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY));
}
