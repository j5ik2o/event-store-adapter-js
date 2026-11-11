export function validateRetryInfoWire(bytes: Uint8Array): void {
  let position = 0;
  const invalid = (): never => {
    throw new RangeError("Invalid RetryInfo wire format");
  };
  const varint = (end: number): bigint => {
    let value = BigInt(0);
    for (let shift = 0; ; shift += 7) {
      if (position >= end) return invalid();
      const byte = bytes[position++];
      if (shift === 63 && byte > 1) return invalid();
      value |= BigInt(byte & 127) << BigInt(shift);
      if ((byte & 128) === 0) return value;
    }
  };
  const uint32 = (end: number): number => {
    const value = varint(end);
    if (value > BigInt(0xffffffff)) return invalid();
    return Number(value);
  };
  const tag = (end: number): number => {
    const value = uint32(end);
    if (value < 8 || value % 8 > 5) return invalid();
    return value;
  };
  const advance = (length: number, end: number): void => {
    if (length > end - position) invalid();
    position += length;
  };
  const skipScalar = (wire: number, end: number): void => {
    switch (wire) {
      case 0: {
        varint(end);
        return;
      }
      case 1:
        advance(8, end);
        return;
      case 2: {
        const length = uint32(end);
        advance(length, end);
        return;
      }
      case 5:
        advance(4, end);
        return;
      default:
        invalid();
    }
  };
  const skipUnknown = (value: number, end: number): void => {
    if (value % 8 !== 3) {
      skipScalar(value % 8, end);
      return;
    }
    const groups = [Math.floor(value / 8)];
    while (groups.length !== 0) {
      const nested = tag(end);
      const field = Math.floor(nested / 8);
      if (nested % 8 === 4) {
        if (groups.pop() !== field) invalid();
      } else if (nested % 8 === 3) groups.push(field);
      else skipScalar(nested % 8, end);
    }
  };
  const duration = (end: number): void => {
    while (position < end) {
      const value = tag(end);
      const field = Math.floor(value / 8);
      if (field === 1 || field === 2) {
        if (value % 8 !== 0) invalid();
        varint(end);
      } else skipUnknown(value, end);
    }
  };
  while (position < bytes.length) {
    const value = tag(bytes.length);
    if (Math.floor(value / 8) === 1) {
      if (value % 8 !== 2) invalid();
      const length = uint32(bytes.length);
      if (length > bytes.length - position) invalid();
      duration(position + length);
    } else skipUnknown(value, bytes.length);
  }
}
