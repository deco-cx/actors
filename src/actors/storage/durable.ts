// deno-lint-ignore-file no-explicit-any
import type {
  ActorStorage,
  ActorStorageGetOptions,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export class DurableStorage implements ActorStorage {
  protected cache: Map<string, any> = new Map<string, any>();
  protected uncommittedChanges: Map<string, any> = new Map<string, any>();
  protected toDelete: Set<string> = new Set<string>();

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
    if (typeof keyOrEntries === "string") {
      // Single key-value put
      const key = keyOrEntries;
      const value = valueOrOptions as T;
      const { allowUnconfirmed } = options || {};
      this.cache.set(key, value);
      if (allowUnconfirmed) {
        await this.innerStorage.put(key, value, options);
      } else {
        this.uncommittedChanges.set(key, value);
      }
    } else {
      // Multiple entries put
      const entries = keyOrEntries as Record<string, T>;
      const { allowUnconfirmed } = (valueOrOptions as ActorStoragePutOptions) ||
        {};

      for (const key in entries) {
        this.cache.set(key, entries[key]);
        if (!allowUnconfirmed) {
          this.uncommittedChanges.set(key, entries[key]);
        }
      }

      if (allowUnconfirmed) {
        await this.innerStorage.put(
          entries,
          valueOrOptions as ActorStoragePutOptions,
        );
      }
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
    const { allowUnconfirmed } = options || {};

    if (typeof keyOrKeys === "string") {
      // Single key delete
      const key = keyOrKeys;
      this.cache.delete(key);
      if (allowUnconfirmed) {
        return await this.innerStorage.delete(key, options);
      } else {
        this.toDelete.add(key);
        return true;
      }
    } else {
      // Multiple keys delete
      const keys = keyOrKeys;
      keys.forEach((key) => this.cache.delete(key));
      if (allowUnconfirmed) {
        return await this.innerStorage.delete(keys, options);
      } else {
        keys.forEach((key) => this.toDelete.add(key));
        return keys.length;
      }
    }
  }

  async deleteAll(options?: ActorStoragePutOptions): Promise<void> {
    const { allowUnconfirmed } = options || {};
    this.cache.clear();
    if (allowUnconfirmed) {
      this.toDelete.clear();
    } else {
      await this.innerStorage.deleteAll(options);
    }
  }

  async atomic(storage: (st: ActorStorage) => Promise<void>): Promise<void> {
    await storage(this);
    await this.commit();
  }

  async commit(): Promise<void> {
    await this.innerStorage.atomic(async (st) => {
      // Commit uncommitted changes
      for (const [key, value] of this.uncommittedChanges.entries()) {
        await st.put(key, value);
      }
      this.uncommittedChanges.clear();

      // Commit deletes
      if (this.toDelete.size > 0) {
        await st.delete([...this.toDelete]);
        this.toDelete.clear();
      }
    });
  }
}
