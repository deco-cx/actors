export const createInitialChunkMessage = (
  messageId: string,
  totalChunks: number,
  totalSize: number,
): Uint8Array => {
  const headerSize = 44; // messageId (36) + totalChunks (4) + totalSize (4)
  const chunk = new Uint8Array(headerSize);
  const view = new DataView(chunk.buffer);

  // Write messageId (36 bytes)
  const messageIdBytes = new TextEncoder().encode(messageId);
  chunk.set(messageIdBytes, 0);

  // Write metadata after the UUID
  view.setUint32(36, totalChunks);
  view.setUint32(40, totalSize);

  return chunk;
};

export const processChunk = (
  chunk: ArrayBuffer,
): {
  messageId: string;
  chunkIndex?: number;
  data?: Uint8Array;
  totalChunks?: number;
  totalSize?: number;
  isInitial?: boolean;
} => {
  const view = new DataView(chunk);
  const messageId = new TextDecoder().decode(new Uint8Array(chunk, 0, 36));

  // Initial message is exactly 44 bytes
  if (chunk.byteLength === 44) {
    return {
      messageId,
      totalChunks: view.getUint32(36),
      totalSize: view.getUint32(40),
      isInitial: true,
    };
  }

  // Data chunks are larger than 44 bytes (include payload)
  return {
    messageId,
    chunkIndex: view.getUint32(36),
    data: new Uint8Array(chunk, 44, view.getUint32(40)),
    isInitial: false,
  };
};

export const createChunk = (
  messageId: string,
  chunkIndex: number,
  data: Uint8Array,
): Uint8Array => {
  // Header: messageId (36 bytes) + chunkIndex (4 bytes) + dataLength (4 bytes)
  const headerSize = 44;
  const chunk = new Uint8Array(headerSize + data.length);
  const view = new DataView(chunk.buffer);

  // Write messageId (36 bytes)
  const messageIdBytes = new TextEncoder().encode(messageId);
  chunk.set(messageIdBytes, 0);

  // Write metadata
  view.setUint32(36, chunkIndex);
  view.setUint32(40, data.length);

  // Write data
  chunk.set(data, headerSize);

  return chunk;
};

export interface ChunkBuffer {
  chunks: Uint8Array[];
  receivedChunks: number;
  totalChunks: number;
  totalSize: number;
}

export async function readAsBytes(
  readable: ReadableStream<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (readable instanceof Uint8Array) {
    return readable;
  }
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine all chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combinedArray = new Uint8Array(totalLength);
  let position = 0;

  for (const chunk of chunks) {
    combinedArray.set(chunk, position);
    position += chunk.length;
  }

  return combinedArray;
}
