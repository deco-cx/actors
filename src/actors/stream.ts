import { deserializeUint8Array } from "./util/buffers.ts";

export const EVENT_STREAM_RESPONSE_HEADER: string = "text/event-stream";
export async function* readFromStream<T>(
  response: Response,
): AsyncIterableIterator<T> {
  if (!response.body) {
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const data of lines) {
      if (!data.startsWith("data:")) {
        continue;
      }

      try {
        const chunk = data.replace("data:", "");
        yield JSON.parse(decodeURIComponent(chunk), deserializeUint8Array);
      } catch (_err) {
        console.log("error parsing data", _err, data);
        continue;
      }
    }
  }

  // Process any remaining buffer after the stream ends
  if (buffer.length > 0 && buffer.startsWith("data:")) {
    try {
      yield JSON.parse(
        decodeURIComponent(buffer.replace("data:", "")),
        deserializeUint8Array,
      );
    } catch (_err) {
      console.log("error parsing data", _err, buffer);
    }
  }
}

export const isEventStreamResponse = (
  invokeResponse: unknown | AsyncIterableIterator<unknown>,
): invokeResponse is AsyncIterableIterator<unknown> => {
  return (
    typeof (invokeResponse as AsyncIterableIterator<unknown>)?.next ===
      "function"
  );
};