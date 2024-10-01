// deno-lint-ignore-file no-explicit-any
import type {
  ActorStorage,
  ActorStorageGetOptions,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export class CachedStorage implements ActorStorage {
  protected cache: Map<string, any> = new Map<string, any>();
  protected alarm: Promise<number | null> | null = null;

  constructor(protected innerStorage: ActorStorage) {}
  setAlarm(dt: number): Promise<void> {
    return this.innerStorage.setAlarm(dt).then(() => {
      this.alarm = Promise.resolve(dt);
    });
  }
  getAlarm(): Promise<number | null> {
    this.alarm ??= this.innerStorage.getAlarm();
    return this.alarm;
  }
  deleteAlarm(): Promise<void> {
    return this.innerStorage.deleteAlarm().then(() => {
      this.alarm = null;
    });
  }

  private async getMany<T = unknown>(
    keys: string[][],
    options?: ActorStorageGetOptions,
  ): Promise<[string[], T][]> {
    const { noCache } = options || {};
    const result: [string[], T][] = [];
    const keysToFetch: string[][] = [];

    for (const key of keys) {
      const keyString = this.keyToString(key);
      if (!noCache && this.cache.has(keyString)) {
        result.push([key, this.cache.get(keyString) as T]);
      } else {
        keysToFetch.push(key);
      }
    }

    if (keysToFetch.length > 0) {
      const fetched = await this.innerStorage.get<T>(keysToFetch, options);
      for (const [key, value] of fetched) {
        this.cache.set(this.keyToString(key), value);
        result.push([key, value]);
      }
    }

    return result;
  }

  // Helper function to convert array of strings into a single string for cache key
  private keyToString(key: string[]): string {
    return key.join(":@:");
  }

  async get<T = unknown>(
    keyOrKeys: string | string[] | string[][],
    options?: ActorStorageGetOptions,
  ): Promise<T | [string[], T][]> {
    if (Array.isArray(keyOrKeys[0])) {
      // If the first element is an array, it's a list of keys
      return this.getMany(keyOrKeys as string[][], options);
    } else {
      // Single key case
      const results = await this.getMany([
        typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys as string[],
      ], options);
      return results[0][1] as T;
    }
  }

  async list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<[string[], T][]> {
    const result = await this.innerStorage.list<T>(options);

    for (const [key, value] of result) {
      const keyString = this.keyToString(key);
      if (this.cache.has(keyString)) {
        result.push([key, this.cache.get(keyString)]);
      } else {
        this.cache.set(keyString, value);
      }
    }

    return result;
  }

  async put<T>(
    keyOrEntries: string | string[] | [string[], T][],
    valueOrOptions?: T | ActorStoragePutOptions,
    options?: ActorStoragePutOptions,
  ): Promise<void> {
    const entries: [string[], T][] = Array.isArray(keyOrEntries[0])
      ? keyOrEntries as [string[], T][]
      : [[
        typeof keyOrEntries === "string"
          ? [keyOrEntries]
          : keyOrEntries as string[],
        valueOrOptions as T,
      ]];

    await this.innerStorage.put(
      entries,
      (Array.isArray(keyOrEntries[0])
        ? valueOrOptions
        : options) as ActorStoragePutOptions,
    );

    for (const [key, value] of entries) {
      this.cache.set(this.keyToString(key), value);
    }
  }

  async delete(
    key: string[],
    options?: ActorStoragePutOptions,
  ): Promise<boolean>;
  async delete(
    keys: string[][],
    options?: ActorStoragePutOptions,
  ): Promise<number>;
  async delete(
    keyOrKeys: string | string[] | string[][],
    options?: ActorStoragePutOptions,
  ): Promise<number | boolean> {
    const keys = Array.isArray(keyOrKeys[0])
      ? keyOrKeys as string[][]
      : [typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys as string[]];

    const result = await this.innerStorage.delete(keys, options);

    keys.forEach((key) => {
      this.cache.delete(this.keyToString(key));
    });

    return Array.isArray(keyOrKeys[0]) ? result : result > 0;
  }

  async deleteAll(options?: ActorStoragePutOptions): Promise<void> {
    this.cache.clear();
    await this.innerStorage.deleteAll(options);
  }

  async atomic(storage: (st: ActorStorage) => Promise<void>): Promise<void> {
    await storage(this);
  }
}
