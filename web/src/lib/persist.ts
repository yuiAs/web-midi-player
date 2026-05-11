// Lightweight persistence for UI preferences and the last-loaded SoundFont.
//
// - Volume / loop live in localStorage: synchronous reads are convenient for
//   $state initializers and the values are tiny scalars.
// - The SF2 reference is stored as a FileSystemFileHandle in IndexedDB.
//   Structured clone preserves the handle so we can re-acquire the file on
//   later visits (subject to user permission). Browsers without the File
//   System Access API simply skip handle persistence — the next load will
//   start unloaded, no error required.

const LS_VOLUME = 'wmp:volume';
const LS_LOOP = 'wmp:loop';

const DB_NAME = 'web-midi-player';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const KEY_SF2 = 'sf2';

export const DEFAULT_VOLUME = 100;
export const DEFAULT_LOOP = false;

export function loadVolume(): number {
  const raw = safeGet(LS_VOLUME);
  if (raw === null) return DEFAULT_VOLUME;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_VOLUME;
}

export function saveVolume(v: number): void {
  safeSet(LS_VOLUME, String(v));
}

export function loadLoop(): boolean {
  return safeGet(LS_LOOP) === '1';
}

export function saveLoop(enabled: boolean): void {
  safeSet(LS_LOOP, enabled ? '1' : '0');
}

export async function loadSf2Handle(): Promise<FileSystemFileHandle | null> {
  if (!hasFsApi()) return null;
  try {
    const db = await openDb();
    return await idbGet(db, STORE_HANDLES, KEY_SF2);
  } catch {
    return null;
  }
}

export async function saveSf2Handle(handle: FileSystemFileHandle): Promise<void> {
  if (!hasFsApi()) return;
  try {
    const db = await openDb();
    await idbPut(db, STORE_HANDLES, KEY_SF2, handle);
  } catch {
    // IndexedDB may be disabled (private mode, quota). Persistence is
    // best-effort; the rest of the UI keeps working.
  }
}

export async function clearSf2Handle(): Promise<void> {
  if (!hasFsApi()) return;
  try {
    const db = await openDb();
    await idbDelete(db, STORE_HANDLES, KEY_SF2);
  } catch {
    // ignore
  }
}

function hasFsApi(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota / disabled storage
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
