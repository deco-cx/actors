// deno-lint-ignore-file no-explicit-any
import type {
  ActorStorage,
  ActorStorageGetOptions,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export class CachedStorage implements ActorStorage {
  protected cache: Map<string, any> = new Map<string, any>();

  constructor(protected innerStorage: ActorStorage) {}

  private async getMany<T = unknown>(
    keys: string[],
    options?: ActorStorageGetOptions,
  ): Promise<Map<string, T>> {
    const { noCache } = options || {};
    const result = new Map<string, T>();
    const keysToFetch: string[] = [];

    for (const key of keys) {
      if (!noCache && this.cache.has(key)) {
        result.set(key, this.cache.get(key) as T);
      } else {
        keysToFetch.push(key);
      }
    }

    if (keysToFetch.length > 0) {
      const fetched = await this.innerStorage.get<T>(keysToFetch, options);
      for (const [key, value] of fetched.entries()) {
        this.cache.set(key, value);
        result.set(key, value);
      }
    }

    return result;
  }
  async get<T = unknown>(
    key: string,
    options?: ActorStorageGetOptions,
  ): Promise<T>;
  async get<T = unknown>(
    keys: string[],
    options?: ActorStorageGetOptions,
  ): Promise<Map<string, T>>;
  async get<T = unknown>(
    keys: string | string[],
    options?: ActorStorageGetOptions,
  ): Promise<Map<string, T> | string> {
    if (typeof keys === "string") {
      const results = await this.getMany<T>([keys], options);
      return results.get(keys) as string;
    }
    return this.getMany(keys, options);
  }

  async list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<Map<string, T>> {
    const result = await this.innerStorage.list<T>(options);

    for (const [key, value] of result.entries()) {
      if (this.cache.has(key)) {
        result.set(key, this.cache.get(key));
      } else {
        this.cache.set(key, value);
      }
    }

    return result;
  }

  async put<T>(
    keyOrEntries: string | Record<string, T>,
    valueOrOptions?: T | ActorStoragePutOptions,
    options?: ActorStoragePutOptions,
  ): Promise<void> {
    const entries = typeof keyOrEntries === "string"
      ? { [keyOrEntries]: valueOrOptions as T }
      : keyOrEntries;
    // Multiple entries put
    await this.innerStorage.put(
      entries,
      (typeof keyOrEntries === "string"
        ? options
        : valueOrOptions) as ActorStoragePutOptions,
    );
    for (const key in entries) {
      this.cache.set(key, entries[key]);
    }
  }

  async delete(
    key: string,
    options?: ActorStoragePutOptions,
  ): Promise<boolean>;
  async delete(
    keys: string[],
    options?: ActorStoragePutOptions,
  ): Promise<number>;

  async delete(
    keyOrKeys: string | string[],
    options?: ActorStoragePutOptions,
  ): Promise<boolean | number> {
    const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
    // Multiple keys delete
    const result = await this.innerStorage.delete(
      keys,
      options,
    );
    keys.forEach((key) => this.cache.delete(key));
    return result;
  }

  async deleteAll(options?: ActorStoragePutOptions): Promise<void> {
    this.cache.clear();
    await this.innerStorage.deleteAll(options);
  }

  async atomic(storage: (st: ActorStorage) => Promise<void>): Promise<void> {
    await storage(this);
  }
}
