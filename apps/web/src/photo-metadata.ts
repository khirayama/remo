export type PhotoMetadata = {
  latitude?: number;
  longitude?: number;
  takenAt?: string;
};

function isUsableCoordinate(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180
    && !(latitude === 0 && longitude === 0);
}

function readString(bytes: Uint8Array, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return "";
  return new TextDecoder().decode(bytes.subarray(offset, offset + length));
}

function parseExif(bytes: Uint8Array, tiffOffset: number, segmentEnd: number): PhotoMetadata | undefined {
  if (tiffOffset + 8 > segmentEnd) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = readString(bytes, tiffOffset, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return undefined;
  const readU16 = (offset: number) => offset + 2 <= segmentEnd ? view.getUint16(offset, littleEndian) : undefined;
  const readU32 = (offset: number) => offset + 4 <= segmentEnd ? view.getUint32(offset, littleEndian) : undefined;
  if (readU16(tiffOffset + 2) !== 42) return undefined;

  type IfdEntry = { type: number; count: number; dataOffset: number };
  function readIfd(offset: number) {
    if (offset < tiffOffset || offset + 2 > segmentEnd) return new Map<number, IfdEntry>();
    const count = readU16(offset);
    if (count === undefined) return new Map<number, IfdEntry>();
    const entries = new Map<number, IfdEntry>();
    for (let index = 0; index < count; index += 1) {
      const entryOffset = offset + 2 + index * 12;
      if (entryOffset + 12 > segmentEnd) break;
      const tag = readU16(entryOffset);
      const type = readU16(entryOffset + 2);
      const itemCount = readU32(entryOffset + 4);
      if (tag === undefined || type === undefined || itemCount === undefined) continue;
      const bytesPerItem = type === 1 || type === 2 || type === 7 ? 1 : type === 3 ? 2 : type === 4 || type === 9 ? 4 : type === 5 || type === 10 ? 8 : 0;
      if (!bytesPerItem) continue;
      const valueLength = bytesPerItem * itemCount;
      const valueOffset = valueLength <= 4 ? entryOffset + 8 : tiffOffset + (readU32(entryOffset + 8) ?? -1);
      if (valueOffset < tiffOffset || valueOffset + valueLength > segmentEnd) continue;
      entries.set(tag, { type, count: itemCount, dataOffset: valueOffset });
    }
    return entries;
  }

  function readAscii(entry: IfdEntry | undefined) {
    if (!entry || (entry.type !== 2 && entry.type !== 1)) return undefined;
    return readString(bytes, entry.dataOffset, entry.count).replace(/\0.*$/, "").trim();
  }

  function readRationals(entry: IfdEntry | undefined) {
    if (!entry || entry.type !== 5 || entry.count < 3) return undefined;
    const values: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const offset = entry.dataOffset + index * 8;
      const numerator = readU32(offset);
      const denominator = readU32(offset + 4);
      if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
      values.push(numerator / denominator);
    }
    return values;
  }

  const firstIfdOffset = readU32(tiffOffset + 4);
  if (firstIfdOffset === undefined) return undefined;
  const ifd = readIfd(tiffOffset + firstIfdOffset);
  const exifIfdOffsetEntry = ifd.get(0x8769);
  const exifIfdOffset = exifIfdOffsetEntry?.type === 4 ? readU32(exifIfdOffsetEntry.dataOffset) : undefined;
  const exifIfd = exifIfdOffset === undefined ? new Map<number, IfdEntry>() : readIfd(tiffOffset + exifIfdOffset);
  const dateTime = readAscii(exifIfd.get(0x9003)) ?? readAscii(exifIfd.get(0x9004)) ?? readAscii(ifd.get(0x0132));
  const gpsOffsetEntry = ifd.get(0x8825);
  const gpsOffset = gpsOffsetEntry?.type === 4 ? readU32(gpsOffsetEntry.dataOffset) : undefined;
  const gps = gpsOffset === undefined ? undefined : readIfd(tiffOffset + gpsOffset);
  const latitude = readRationals(gps?.get(2));
  const longitude = readRationals(gps?.get(4));
  const latitudeRef = readAscii(gps?.get(1))?.toUpperCase();
  const longitudeRef = readAscii(gps?.get(3))?.toUpperCase();
  const parsedLatitude = latitude ? latitude[0] + latitude[1] / 60 + latitude[2] / 3600 : undefined;
  const parsedLongitude = longitude ? longitude[0] + longitude[1] / 60 + longitude[2] / 3600 : undefined;
  const metadata: PhotoMetadata = {};
  if (parsedLatitude !== undefined && parsedLongitude !== undefined && isUsableCoordinate(parsedLatitude, parsedLongitude)) {
    metadata.latitude = latitudeRef === "S" ? -parsedLatitude : parsedLatitude;
    metadata.longitude = longitudeRef === "W" ? -parsedLongitude : parsedLongitude;
  }
  if (dateTime) {
    const match = /^(\d{4}):(\d{2}):(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
      if (Number.isFinite(date.getTime())) metadata.takenAt = date.toISOString();
    }
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

export function parsePhotoMetadata(input: ArrayBuffer | Uint8Array): PhotoMetadata | undefined {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xda || marker === 0xd9 || marker === undefined) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (marker === 0xe1 && readString(bytes, segmentStart, 6) === "Exif\0\0") {
      return parseExif(bytes, segmentStart + 6, segmentEnd);
    }
    offset = segmentEnd;
  }
  return undefined;
}

export async function readPhotoMetadata(file: Blob): Promise<PhotoMetadata | undefined> {
  try {
    // EXIF is stored in the JPEG header. Avoid reading a full camera original
    // just to find metadata while the thumbnail can already be shown.
    return parsePhotoMetadata(await file.slice(0, 512 * 1024).arrayBuffer());
  } catch {
    return undefined;
  }
}
