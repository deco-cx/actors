import { join } from "@std/path";
import type {
  ActorStorage,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export interface StorageOptions {
  actorName: string;
  actorId: string;
  atomicOp?: AtomicOp;
}

const ACTORS_KV_DATABASE = Deno.env.get("ACTORS_KV_DATABASE") ??
  join(Deno.cwd(), "kv");

const ACTORS_DENO_KV_TOKEN = Deno.env.get("ACTORS_DENO_KV_TOKEN");
// this is necessary since deno cluster does not allow inject DENO_* env vars. so this is a workaround to make it work.
ACTORS_DENO_KV_TOKEN &&
  Deno.env.set("DENO_KV_ACCESS_TOKEN", ACTORS_DENO_KV_TOKEN);

const kv = await Deno.openKv(ACTORS_KV_DATABASE);

interface AtomicOp {
  kv: Deno.AtomicOperation;
  dirty: Deno.KvEntryMaybe<unknown>[];
}
export class DenoKvActorStorage implements ActorStorage {
  private kv: Deno.Kv;
  private atomicOp?: AtomicOp;
  private kvOrTransaction: Deno.Kv | Deno.AtomicOperation;
  constructor(protected options: StorageOptions) {
    this.kv = kv; // Initialize the Deno.Kv instance
    this.kvOrTransaction = options.atomicOp?.kv ?? kv;
    this.atomicOp = options.atomicOp;
  }

  async atomic(_storage: (st: ActorStorage) => Promise<void>): Promise<void> {
    if (this.atomicOp) {
      throw new Error(`not implemented`);
    }
    const atomicOp = this.kv.atomic();
    const dirty: Deno.KvEntryMaybe<unknown>[] = [];
    const st = new DenoKvActorStorage({
      ...this.options,
      atomicOp: {
        kv: atomicOp,
        dirty,
      },
    });
    return await _storage(st).then(async () => {
      // performs OCC check (optimistic concurrency control)
      for (const entry of dirty) {
        atomicOp.check(entry);
      }
      const result = await atomicOp.commit();
      if (!result.ok) {
        throw new Error(`atomic operation failed`);
      }
    });
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
      this.atomicOp?.dirty?.push(result);
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

    const batch = this.atomicOp?.kv ?? this.kv.atomic();
    for (const key of fullKeys) {
      batch.delete(this.buildKey(key));
      deletedCount++;
    }
    !this.atomicOp && await batch.commit();

    return Array.isArray(keys) ? deletedCount : deletedCount > 0;
  }

  // Delete all records within a certain range based on the options provided
  async deleteAll(): Promise<void> {
    const iter = await this.list();

    const batch = this.atomicOp?.kv ?? this.kv.atomic();
    for (const [key] of iter) {
      batch.delete(this.buildKey(key));
    }

    !this.atomicOp && await batch.commit();
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
