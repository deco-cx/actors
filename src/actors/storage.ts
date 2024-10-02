export interface ActorStorageListOptions {
  start?: string[];
  startAfter?: string[];
  end?: string[];
  prefix?: string[];
  reverse?: boolean;
  limit?: number;
  noCache?: boolean;
}
export interface ActorStorageGetOptions {
  noCache?: boolean;
}

export interface ActorStoragePutOptions {
  noCache?: boolean;
}

/**
 * Represents the storage of an actor.
 */
export interface ActorStorage {
  get<T = unknown>(
    key: string,
    options?: ActorStorageGetOptions,
  ): Promise<T>;
  get<T = unknown>(
    key: string[],
    options?: ActorStorageGetOptions,
  ): Promise<T>;
  get<T = unknown>(
    keys: string[][],
    options?: ActorStorageGetOptions,
  ): Promise<[string[], T][]>;
  list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<[string[], T][]>;
  put<T>(
    key: string,
    value: T,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  put<T>(
    key: string[],
    value: T,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  put<T>(
    entries: [string[], T][],
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  delete(key: string[], options?: ActorStoragePutOptions): Promise<boolean>;
  delete(key: string[], options?: ActorStoragePutOptions): Promise<boolean>;
  delete(keys: string[][], options?: ActorStoragePutOptions): Promise<number>;
  deleteAll(options?: ActorStoragePutOptions): Promise<void>;
  atomic(storage: (st: ActorStorage) => Promise<void>): Promise<void>;
  setAlarm(dt: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}
