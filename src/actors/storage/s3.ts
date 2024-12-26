import process from "node:process";
import type {
  ActorStorage,
  ActorStorageGetOptions,
  ActorStorageListOptions,
  ActorStoragePutOptions,
} from "../storage.ts";

export interface StorageOptions {
  actorName: string;
  actorId: string;
}

export class S3ActorStorage implements ActorStorage {
  private bucketName: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string;

  constructor(protected options: StorageOptions) {
    this.bucketName = process.env.DECO_ACTORS_S3_BUCKET_NAME!;
    this.accessKeyId = process.env.AWS_ACCESS_KEY_ID!;
    this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY!;
    this.region = process.env.AWS_REGION! ?? "us-east-1";
  }
  setAlarm(_dt: number): Promise<void> {
    throw new Error("Method not implemented.");
  }
  getAlarm(): Promise<number | null> {
    throw new Error("Method not implemented.");
  }
  deleteAlarm(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  // Build the full key based on actor name, id, and provided key
  buildKey(key: string[]): string {
    return [this.options.actorName, this.options.actorId, ...key].join("/");
  }

  // Overloaded get methods
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
    options?: ActorStorageGetOptions,
  ): Promise<T | [string[], T][]> {
    if (Array.isArray(keyOrKeys) && Array.isArray(keyOrKeys[0])) {
      // keys: string[][]
      const result: [string[], T][] = [];
      for (const key of keyOrKeys as string[][]) {
        const value = await this.get<T>(key, options);
        if (value !== undefined) {
          result.push([key, value]);
        }
      }
      return result;
    } else {
      // key: string | string[]
      const keyArray = Array.isArray(keyOrKeys)
        ? keyOrKeys as string[]
        : [keyOrKeys];
      const key = this.buildKey(keyArray);
      const response = await this.getObject(key);
      if (response.status === 200) {
        const data = await response.text();
        return JSON.parse(data) as T;
      } else if (response.status === 404) {
        await response.body?.cancel();
        return undefined as T;
      } else {
        await response.body?.cancel();
        throw new Error(`Failed to get object: ${response.statusText}`);
      }
    }
  }

  // Overloaded put methods
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
      // entries: [string[], T][]
      const entries = keyOrEntries as [string[], T][];
      for (const [keyParts, value] of entries) {
        const key = this.buildKey(keyParts);
        const body = JSON.stringify(value);
        const response = await this.putObject(key, body);
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(
            `Failed to put object: ${response.statusText}`,
          );
        }
        await response.body?.cancel();
      }
    } else {
      // key: string | string[], value: T
      const keyArray = Array.isArray(keyOrEntries)
        ? keyOrEntries as string[]
        : [keyOrEntries];
      const value = valueOrOptions as T;
      const key = this.buildKey(keyArray);
      const body = JSON.stringify(value);
      const response = await this.putObject(key, body);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`Failed to put object: ${response.statusText}`);
      }
      await response.body?.cancel();
    }
  }

  // Overloaded delete methods
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
    if (Array.isArray(keyOrKeys[0])) {
      // keys: string[][]
      const keys = keyOrKeys as string[][];
      let deletedCount = 0;
      for (const keyParts of keys) {
        const key = this.buildKey(keyParts);
        const response = await this.deleteObject(key);
        if (response.status === 204 || response.status === 200) {
          deletedCount++;
        }
        await response.body?.cancel();
      }
      return deletedCount;
    } else {
      // key: string[]
      const keyParts = typeof keyOrKeys === "string"
        ? [keyOrKeys]
        : keyOrKeys as string[];
      const key = this.buildKey(keyParts);
      const response = await this.deleteObject(key);
      await response.body?.cancel();
      return response.status === 204 || response.status === 200;
    }
  }

  // Implement the deleteAll method
  async deleteAll(_options?: ActorStoragePutOptions): Promise<void> {
    const prefix = this.buildKey([]);
    const objects = await this.listObjects(prefix);
    for (const object of objects) {
      await this.deleteObject(object.Key);
    }
  }

  // Implement the list method
  async list<T = unknown>(
    options?: ActorStorageListOptions,
  ): Promise<[string[], T][]> {
    const prefix = this.buildKey(options?.prefix ?? []);
    const objects = await this.listObjects(prefix);

    const result: [string[], T][] = [];
    for (const object of objects) {
      const key = object.Key;
      const keyParts = key.split("/").slice(2); // Remove actorName and actorId
      const value = await this.get<T>(keyParts);
      if (value !== undefined) {
        result.push([keyParts, value]);
      }
    }

    return result;
  }

  // Implement the atomic method
  atomic(_storage: (st: ActorStorage) => Promise<void>): Promise<void> {
    throw new Error(
      "Atomic operations are not supported in S3ActorStorage.",
    );
  }

  // Helper method to get an object from S3
  private async getObject(key: string): Promise<Response> {
    const method = "GET";
    const url =
      `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
    const headers = await this.getSignedHeaders(method, key);
    return await fetch(url, { method, headers });
  }

  // Helper method to put an object to S3
  private async putObject(key: string, body: string): Promise<Response> {
    const method = "PUT";
    const url =
      `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
    const headers = await this.getSignedHeaders(method, key, body);
    return await fetch(url, { method, headers, body });
  }

  // Helper method to delete an object from S3
  private async deleteObject(key: string): Promise<Response> {
    const method = "DELETE";
    const url =
      `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
    const headers = await this.getSignedHeaders(method, key);
    return await fetch(url, { method, headers });
  }

  // Helper method to list objects in S3
  private async listObjects(prefix: string): Promise<{ Key: string }[]> {
    const method = "GET";
    const url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/`;
    const params = new URLSearchParams({
      "list-type": "2",
      "prefix": prefix,
    });
    const fullUrl = `${url}?${params.toString()}`;
    const headers = await this.getSignedHeaders(method, "", "", params);
    const response = await fetch(fullUrl, { method, headers });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Failed to list objects: ${response.statusText}`);
    }
    const text = await response.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, "application/xml");
    const keys = Array.from(xmlDoc.getElementsByTagName("Contents"))
      .map((content) => {
        const keyNode = content.getElementsByTagName("Key")[0];
        return { Key: keyNode.textContent! };
      });
    return keys;
  }

  // Helper method to generate signed headers for S3 requests
  private async getSignedHeaders(
    method: string,
    key: string,
    body: string = "",
    params: URLSearchParams = new URLSearchParams(),
  ): Promise<Headers> {
    const service = "s3";
    const host = `${this.bucketName}.s3.${this.region}.amazonaws.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const credentialScope =
      `${dateStamp}/${this.region}/${service}/aws4_request`;
    const canonicalUri = `/${key}`;
    const canonicalQuerystring = params.toString();
    const payloadHash = await this.hash(body);
    const canonicalHeaders = `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await this.hash(canonicalRequest),
    ].join("\n");

    const signingKey = await this.getSignatureKey(
      this.secretAccessKey,
      dateStamp,
      this.region,
      service,
    );

    const signature = await this.hmac(signingKey, stringToSign);

    const authorizationHeader = [
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", ");

    const headers = new Headers();
    headers.set("x-amz-date", amzDate);
    headers.set("Authorization", authorizationHeader);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("Host", host);
    if (body && method !== "GET" && method !== "DELETE") {
      headers.set("Content-Type", "application/octet-stream");
      headers.set("Content-Length", body.length.toString());
    }
    return headers;
  }

  private async hash(stringToHash: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(stringToHash);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async hmac(
    key: ArrayBuffer,
    data: string,
  ): Promise<string> {
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const signature = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      dataBytes,
    );
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async getSignatureKey(
    key: string,
    dateStamp: string,
    regionName: string,
    serviceName: string,
  ): Promise<ArrayBuffer> {
    const kDate = await this.hmacDigest(`AWS4${key}`, dateStamp);
    const kRegion = await this.hmacDigest(kDate, regionName);
    const kService = await this.hmacDigest(kRegion, serviceName);
    const kSigning = await this.hmacDigest(kService, "aws4_request");
    return kSigning;
  }

  private async hmacDigest(
    key: string | ArrayBuffer,
    data: string,
  ): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
    const dataBytes = encoder.encode(data);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  }
}
