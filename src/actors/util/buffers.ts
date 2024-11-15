export interface SerializedUint8Array {
  __uint8array: number[];
}

const isSerializedUint8Array = (
  s: unknown | SerializedUint8Array,
): s is SerializedUint8Array => {
  return typeof s === "object" &&
    (s as SerializedUint8Array)?.__uint8array instanceof Array;
};
export const serializeUint8Array = (_: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return {
      __uint8array: Array.from(value), // Mark arrays that should be Uint8Array
    };
  }
  return value;
};

export const deserializeUint8Array = (
  _: string,
  value: unknown | SerializedUint8Array,
) => {
  if (isSerializedUint8Array(value)) {
    return new Uint8Array(value.__uint8array);
  }
  return value;
};
