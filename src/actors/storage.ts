export interface ActorStorageListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
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

export interface ActorStorage {
  get<T = unknown>(
    key: string,
    options?: ActorStorageGetOptions,
  ): Promise<T>;
  get<T = unknown>(
    keys: string[],
    options?: ActorStorageGetOptions,
  ): Promise<Map<string, T>>;
  list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  put<T>(
    entries: Record<string, T>,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  delete(key: string, options?: ActorStoragePutOptions): Promise<boolean>;
  delete(keys: string[], options?: ActorStoragePutOptions): Promise<number>;
  deleteAll(options?: ActorStoragePutOptions): Promise<void>;
  atomic(storage: (st: ActorStorage) => Promise<void>): Promise<void>;
}
