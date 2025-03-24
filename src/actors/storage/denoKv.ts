// deno-lint-ignore-file no-explicit-any
import { join } from "node:path";
import process from "node:process";
import type {
  ActorStorage,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";
import {
  type ActorRuntime,
  ACTORS_API_SEGMENT,
  ACTORS_INVOKE_API_SEGMENT,
} from "../runtime.ts";
import { ACTOR_ID_QS_NAME } from "../stub/stub.ts";

export interface StorageOptions {
  actorName: string;
  actorId: string;
  atomicOp?: AtomicOp;
  runtime?: ActorRuntime<any>;
}

const ACTORS_KV_DATABASE = process?.env?.ACTORS_KV_DATABASE ??
  join(process.cwd(), "kv");

const ACTORS_DENO_KV_TOKEN = process?.env?.ACTORS_DENO_KV_TOKEN;
if (ACTORS_DENO_KV_TOKEN) {
  process.env.DENO_KV_ACCESS_TOKEN = ACTORS_DENO_KV_TOKEN;
}

let kv: Deno.Kv | null = null;

try {
  kv = await Deno?.openKv(ACTORS_KV_DATABASE);
} catch {
  // ignore
}
function assertIsDefined<V>(
  v: V | NonNullable<V>,
): asserts v is NonNullable<V> {
  const isDefined = v !== null && typeof v !== "undefined";
  if (!isDefined) {
    throw new Error(`Expected 'v' to be defined, but received ${v}`);
  }
}
interface AtomicOp {
  kv: Deno.AtomicOperation;
  dirty: Deno.KvEntryMaybe<unknown>[];
}

export class DenoKvActorStorage implements ActorStorage {
  private kv: Deno.Kv;
  private atomicOp?: AtomicOp;
  private kvOrTransaction: Deno.Kv | Deno.AtomicOperation;
  private alarmTimeout?: number;
  private alarmTime: number | null = null;

  constructor(protected options: StorageOptions) {
    assertIsDefined(kv);
    this.kv = kv;
    this.kvOrTransaction = options.atomicOp?.kv ?? kv;
    this.atomicOp = options.atomicOp;
  }
  private warnAlams() {
    console.warn(
      "Alarms is in testing mode, it will work until the process is killed",
    );
  }

  private async triggerAlarm() {
    if (!this.options.runtime) {
      throw new Error("Runtime is not set");
    }
    const { actorId, actorName } = this.options;
    const url = new URL(
      `/${ACTORS_API_SEGMENT}/${actorName}/${ACTORS_INVOKE_API_SEGMENT}/alarm?${ACTOR_ID_QS_NAME}=${actorId}`,
      "http://localhost",
    );
    const response = await this.options.runtime.fetch(
      new Request(url, { method: "POST" }),
    );
    if (!response.ok) {
      throw new Error(
        `alarm error: ${await response.text()} ${response.status}`,
      );
    }
  }
  setAlarm(dt: number): Promise<void> {
    this.warnAlams();
    // Clear any existing alarm
    if (this.alarmTimeout) {
      clearTimeout(this.alarmTimeout);
    }

    this.alarmTime = dt;
    const delay = dt - Date.now();

    if (delay > 0) {
      this.alarmTimeout = setTimeout(async () => {
        this.alarmTime = null;
        await this.triggerAlarm().catch((e) => {
          console.error("alarm error", e);
        });
      }, delay);
    }

    return Promise.resolve();
  }
  getAlarm(): Promise<number | null> {
    this.warnAlams();
    return Promise.resolve(this.alarmTime);
  }
  deleteAlarm(): Promise<void> {
    this.warnAlams();
    if (this.alarmTimeout) {
      clearTimeout(this.alarmTimeout);
      this.alarmTimeout = undefined;
    }
    this.alarmTime = null;
    return Promise.resolve();
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
  buildKey(key: string[]): string[] {
    return [this.options.actorName, this.options.actorId, ...key];
  }

  // Single get method that handles both single and multiple keys
  async get<T = unknown>(
    keyOrKeys: string | string[] | string[][],
  ): Promise<T | [string[], T][]> {
    if (Array.isArray(keyOrKeys[0])) {
      const result: [string[], T][] = [];
      for (const key of keyOrKeys as string[][]) {
        const value = await this.get<T>(key) as T;
        if (value !== undefined) {
          result.push([key, value]);
        }
      }
      return result;
    } else {
      const result = await this.kv.get<T>(
        this.buildKey(
          Array.isArray(keyOrKeys) ? keyOrKeys as string[] : [keyOrKeys],
        ),
      );
      this.atomicOp?.dirty?.push(result);
      return result?.value!;
    }
  }

  // Put function that stores value in Deno.Kv
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
    entry: string | string[] | [string[], T][],
    valueOrOptions?: T | ActorStoragePutOptions,
    _options?: ActorStoragePutOptions,
  ): Promise<void> {
    const entries: [string[], T][] = Array.isArray(entry[0])
      ? entry as [string[], T][]
      : [[
        typeof entry === "string" ? [entry] : entry as string[],
        valueOrOptions as T,
      ]];

    for (const [key, value] of entries) {
      await this.kvOrTransaction.set(this.buildKey(key), value);
    }
  }

  // Delete function that removes keys from Deno.Kv
  async delete(key: string, options?: ActorStoragePutOptions): Promise<boolean>;
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
    const keys = Array.isArray(keyOrKeys[0])
      ? keyOrKeys as string[][]
      : [typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys as string[]];

    let deletedCount = 0;
    const batch = this.atomicOp?.kv ?? this.kv.atomic();
    for (const key of keys) {
      batch.delete(this.buildKey(key));
      deletedCount++;
    }
    !this.atomicOp && await batch.commit();

    return Array.isArray(keyOrKeys[0]) ? deletedCount : deletedCount > 0;
  }

  // Delete all records within a range
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
  ): Promise<[string[], T][]> {
    const result: [string[], T][] = [];
    const selector = {
      start: options?.start ? this.buildKey(options.start) : undefined,
      end: options?.end ? this.buildKey(options.end) : undefined,
      prefix: options?.prefix ? this.buildKey(options.prefix) : [],
    };
    const iter = this.kv.list<T>(
      selector,
      {
        limit: options?.limit ?? 1000,
        reverse: options?.reverse,
      },
    );

    for await (const entry of iter) {
      result.push([(entry.key as string[]).slice(-2), entry.value]);
    }

    return result;
  }
}
