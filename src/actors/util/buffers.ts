export interface Uint8ArraySerialized {
  __type: "Uint8Array";
  value: string;
}

const isUint8ArraySerialized = (
  v: unknown | Uint8ArraySerialized,
): v is Uint8ArraySerialized => {
  return typeof v === "object" &&
    (v as Uint8ArraySerialized)?.__type === "Uint8Array";
};

export const deserializeUint8Array = (
  _key: string,
  value: unknown | Uint8ArraySerialized,
) => {
  if (isUint8ArraySerialized(value)) {
    const binaryString = atob(value.value);
    return new Uint8Array(
      binaryString.split("").map((char) => char.charCodeAt(0)),
    );
  }
  return value;
};

export const serializeUint8Array = (
  _: string,
  value: unknown,
): unknown | Uint8ArraySerialized => {
  if (value instanceof Uint8Array) {
    return {
      __type: "Uint8Array",
      value: btoa(String.fromCharCode(...value)),
    };
  }
  return value;
};
