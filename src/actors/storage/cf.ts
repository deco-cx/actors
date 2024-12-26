import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { ActorDOId } from "../runtimes/cf/fetcher.ts";
import type {
  ActorStorage,
  ActorStorageGetOptions,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export const WELL_KNOWN_DO_NAME_KEY = "DURABLE_OBJECT_NAME";

export class DurableObjectNameStorage {
  constructor(
    private storage: DurableObjectStorage | DurableObjectTransaction,
    private options: {
      actorName: string;
      actorId: string;
    },
  ) {
  }

  static get(st: DurableObjectStorage | DurableObjectTransaction) {
    return st.get(WELL_KNOWN_DO_NAME_KEY);
  }

  async saveOnce() {
    const name = await DurableObjectNameStorage.get(this.storage);
    if (name) return;

    return this.storage.put(
      WELL_KNOWN_DO_NAME_KEY,
      ActorDOId.build({
        name: this.options.actorName,
        id: this.options.actorId,
      }),
    );
  }
}

export class DurableObjectActorStorage implements ActorStorage {
  private nameStorage: DurableObjectNameStorage;
  constructor(
    private storage: DurableObjectStorage | DurableObjectTransaction,
    private options: {
      actorName: string;
      actorId: string;
    },
  ) {
    this.nameStorage = new DurableObjectNameStorage(storage, options);
  }

  async setAlarm(dt: number): Promise<void> {
    await this.nameStorage.saveOnce();
    return this.storage.setAlarm(dt);
  }
  getAlarm(): Promise<number | null> {
    return this.storage.getAlarm();
  }
  deleteAlarm(): Promise<void> {
    return this.storage.deleteAlarm();
  }

  private buildKey(key: string[] | string[][]): string {
    return `${this.options.actorName}:${this.options.actorId}:${
      key.flatMap((k) => k).join(":")
    }`;
  }

  private stripPrefix(key: string): string[] {
    const parts = key.split(":");
    return parts.slice(2); // Remove actorName and actorId
  }

  async get<T = unknown>(
    key: string,
    options?: ActorStorageGetOptions,
  ): Promise<T>;
  async get<T = unknown>(
    key: string[],
    options?: ActorStorageGetOptions,
  ): Promise<T>;
  async get<T = unknown>(
    keys: string[][],
    options?: ActorStorageGetOptions,
  ): Promise<[string[], T][]>;
  async get<T = unknown>(
    keyOrKeys: string | string[] | string[][],
    _options?: ActorStorageGetOptions,
  ): Promise<T | [string[], T][]> {
    if (Array.isArray(keyOrKeys)) {
      if (Array.isArray(keyOrKeys[0])) {
        // Multiple keys case
        const keys = (keyOrKeys as string[][]).map((k) => this.buildKey(k));
        const result: Map<string, T> = await this.storage.get<T>(keys);
        return Array.from(result.entries()).map(([key, value]) => [
          this.stripPrefix(key),
          value,
        ]);
      } else {
        // Single array key case
        const value = await this.storage.get<T>(
          this.buildKey(keyOrKeys as string[]),
        );
        return value as T;
      }
    } else {
      // Single string key case
      const value = await this.storage.get<T>(this.buildKey([keyOrKeys]));
      return value as T;
    }
  }

  async put<T>(
    key: string,
    value: T,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  async put<T>(
    key: string[],
    value: T,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  async put<T>(
    entries: [string[], T][],
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  async put<T>(
    keyOrEntries: string | string[] | [string[], T][],
    valueOrOptions?: T | ActorStoragePutOptions,
    _options?: ActorStoragePutOptions,
  ): Promise<void> {
    if (Array.isArray(keyOrEntries) && Array.isArray(keyOrEntries[0])) {
      // Multiple entries case
      const entries = (keyOrEntries as [string[], T][]).reduce(
        (acc, [key, value]) => {
          acc[this.buildKey(key)] = value;
          return acc;
        },
        {} as Record<string, T>,
      );
      await this.storage.put(entries);
    } else {
      // Single entry case
      const key = Array.isArray(keyOrEntries)
        ? keyOrEntries as string[]
        : [keyOrEntries as string];
      await this.storage.put(this.buildKey(key), valueOrOptions as T);
    }
  }

  async delete(
    key: string,
    options?: ActorStoragePutOptions,
  ): Promise<boolean>;
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
    _options?: ActorStoragePutOptions,
  ): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys) && Array.isArray(keyOrKeys[0])) {
      // Multiple keys case
      const keys = (keyOrKeys as string[][]).map((k) => this.buildKey(k));
      return await this.storage.delete(keys);
    } else {
      // Single key case
      const key = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys as string];
      return await this.storage.delete(this.buildKey(key));
    }
  }

  async deleteAll(_options?: ActorStoragePutOptions): Promise<void> {
    const prefix = `${this.options.actorName}:${this.options.actorId}:`;
    const entries = await this.storage.list<unknown>({ prefix });

    if (entries.size > 0) {
      await this.storage.delete(Array.from(entries.keys()));
    }
  }

  async list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<[string[], T][]> {
    const prefix = `${this.options.actorName}:${this.options.actorId}:`;

    let startKey = options?.start ? this.buildKey(options.start) : undefined;
    let endKey = options?.end ? this.buildKey(options.end) : undefined;

    if (options?.prefix) {
      const prefixKey = this.buildKey(options.prefix);
      startKey = startKey
        ? (startKey < prefixKey ? prefixKey : startKey)
        : prefixKey;
      endKey = endKey
        ? (endKey > prefixKey + "\uffff" ? prefixKey + "\uffff" : endKey)
        : prefixKey + "\uffff";
    }

    const entries: Map<string, T> = await this.storage.list<T>({
      prefix,
      start: startKey,
      end: endKey,
      reverse: options?.reverse,
      limit: options?.limit,
    });

    return Array.from(entries.entries()).map(([key, value]) => [
      this.stripPrefix(key),
      value,
    ]);
  }

  async atomic(closure: (st: ActorStorage) => Promise<void>): Promise<void> {
    await this.storage.transaction(async (txn: DurableObjectTransaction) => {
      const storage = new DurableObjectActorStorage(txn, this.options);
      await closure(storage);
    });
  }
}
