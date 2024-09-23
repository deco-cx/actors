import { join } from "@std/path";
import type {
  ActorStorage,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export interface StorageOptions {
  actorName: string;
  actorId: string;
  atomicOp?: Deno.AtomicOperation;
}

const kv = await Deno.openKv(join(Deno.cwd(), "kv"));

export class DenoKvActorStorage implements ActorStorage {
  private kv: Deno.Kv;
  private atomicOp?: Deno.AtomicOperation;
  private kvOrTransaction: Deno.Kv | Deno.AtomicOperation;
  constructor(protected options: StorageOptions) {
    this.kv = kv; // Initialize the Deno.Kv instance
    this.kvOrTransaction = options.atomicOp ?? kv;
    this.atomicOp = options.atomicOp;
  }

  atomic(_storage: (st: ActorStorage) => Promise<void>): Promise<void> {
    if (this.kv instanceof Deno.AtomicOperation) {
      throw new Error(`not implemented`);
    }
    const st = new DenoKvActorStorage({
      ...this.options,
      atomicOp: this.kv.atomic(),
    });
    return _storage(st);
  }

  // Build the full key based on actor name, id, and provided key
  buildKey(key: string): string[] {
    return [this.options.actorName, this.options.actorId, key];
  }

  // Single get method that handles both string and array of strings
  async get<T = unknown>(
    keyOrKeys: string | string[],
  ): Promise<T | undefined | Map<string, T>> {
    // If the input is a single string, perform a single get
    if (typeof keyOrKeys === "string") {
      const result = await this.kv.get<T>(this.buildKey(keyOrKeys));
      return result?.value ?? undefined;
    }

    // If the input is an array of strings, perform multiple gets and return a Map
    const result = new Map<string, T>();
    for (const key of keyOrKeys) {
      const value = await this.get<T>(key) as T;
      if (value !== undefined) {
        result.set(key, value);
      }
    }

    return result;
  }

  // Put function that directly stores the value in Deno.Kv
  async put<T>(
    key: string,
    value: T,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  async put<T>(
    entries: Record<string, T>,
    options?: ActorStoragePutOptions,
  ): Promise<void>;
  async put<T>(
    entry: string | Record<string, T>,
    value: T | ActorStoragePutOptions,
  ): Promise<void> {
    const entries = typeof entry === "string" ? { [entry]: value } : entry;

    for (const [key, value] of Object.entries(entries)) {
      await this.kvOrTransaction.set(this.buildKey(key), value);
    }
  }

  // Delete function that removes keys from Deno.Kv
  async delete(key: string, options?: ActorStoragePutOptions): Promise<boolean>;
  async delete(
    keys: string[],
    options?: ActorStoragePutOptions,
  ): Promise<number>;
  async delete(
    keys: string | string[],
  ): Promise<number | boolean> {
    const fullKeys = Array.isArray(keys) ? keys : [keys];
    let deletedCount = 0;

    const batch = this.atomicOp ?? this.kv.atomic();
    for (const key of fullKeys) {
      batch.delete(this.buildKey(key));
      deletedCount++;
    }
    await batch.commit();

    return Array.isArray(keys) ? deletedCount : deletedCount > 0;
  }

  // Delete all records within a certain range based on the options provided
  async deleteAll(): Promise<void> {
    const iter = await this.list();

    const batch = this.atomicOp ?? this.kv.atomic();
    for (const [key] of iter) {
      batch.delete(this.buildKey(key));
    }

    await batch.commit();
  }

  // List records in the storage with optional range and filtering
  async list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<Map<string, T>> {
    const map = new Map<string, T>();
    const iter = this.kv.list<T>(
      {
        start: options?.start ? this.buildKey(options.start) : [],
        end: options?.end ? this.buildKey(options.end) : [],
        prefix: options?.prefix ? this.buildKey(options.prefix) : [],
      },
      {
        limit: options?.limit,
        reverse: options?.reverse,
      },
    );

    for await (const entry of iter) {
      map.set(entry.key[entry.key.length - 1].toString(), entry.value);
    }
    return map;
  }
}
