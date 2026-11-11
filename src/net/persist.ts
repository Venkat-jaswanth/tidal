// Keeps the world between visits: the leader saves a particle snapshot every couple of seconds, and
// a window that opens with nobody else around pours the saved liquid back in.

import type { Snapshot } from './transport';

const DB = 'tidal';
const STORE = 'world';
const KEY = 'latest';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

export async function saveWorld(snapshot: Snapshot): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
    });
    db.close();
  } catch {
    // storage can be unavailable (private mode, quota); the world then simply starts fresh next time
  }
}

export async function loadWorld(): Promise<Snapshot | null> {
  try {
    const db = await open();
    const value = await new Promise<Snapshot | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result as Snapshot | undefined);
      req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
    });
    db.close();
    return value && value.count > 0 && value.data instanceof Uint8Array ? value : null;
  } catch {
    return null;
  }
}
