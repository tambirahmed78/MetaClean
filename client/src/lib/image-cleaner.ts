export type Finding = {
  id: string;
  title: string;
  description: string;
  found: boolean;
};

export type OutputOptions = {
  keepColors: boolean;
  makeUnique: boolean;
};

const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isSupportedImage(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return supportedTypes.has(file.type.toLowerCase()) || ["jpg", "jpeg", "png", "webp"].includes(extension ?? "");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function includesBytes(haystack: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= haystack.length - bytes.length; i += 1) {
    for (let j = 0; j < bytes.length; j += 1) {
      if (haystack[i + j] !== bytes[j]) continue outer;
    }
    return true;
  }
  return false;
}

function hasGpsSubIfd(payload: Uint8Array): boolean {
  const signature = includesBytes(payload.subarray(0, Math.min(payload.length, 6)), "Exif\u0000\u0000");
  const base = signature ? 6 : 0;
  if (payload.length < base + 8) return false;
  const littleEndian = payload[base] === 0x49 && payload[base + 1] === 0x49;
  if (!littleEndian && !(payload[base] === 0x4d && payload[base + 1] === 0x4d)) return false;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const read16 = (offset: number) => offset >= 0 && offset + 2 <= payload.length ? view.getUint16(offset, littleEndian) : -1;
  const read32 = (offset: number) => offset >= 0 && offset + 4 <= payload.length ? view.getUint32(offset, littleEndian) : -1;
  if (read16(base + 2) !== 42) return false;
  const ifd0 = base + read32(base + 4);
  const entries = read16(ifd0);
  if (entries < 0 || ifd0 + 2 + entries * 12 > payload.length) return false;
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd0 + 2 + index * 12;
    if (read16(entry) === 0x8825) {
      const gpsIfd = base + read32(entry + 8);
      const gpsEntries = read16(gpsIfd);
      return gpsEntries > 0 && gpsIfd + 2 + gpsEntries * 12 <= payload.length;
    }
  }
  return false;
}

function inspectChunks(bytes: Uint8Array) {
  const found = new Set<string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 8 * 1024 * 1024))).toLowerCase();

  const has = (...terms: string[]) => terms.some((term) => text.includes(term));
  if (has("exif", "tiff", "camera make", "camera model", "software")) found.add("exif");
  if (has("gpslatitude", "gpslongitude", "gpsinfo", "latitude", "longitude", "gps\u0000")) found.add("gps");
  if (has("iptc", "photoshop 3.0", "iim")) found.add("iptc");
  if (has("xmp", "adobe:ns:meta", "rdf:rdf")) found.add("xmp");
  if (has("c2pa", "content credentials", "c2pa.manifest")) found.add("c2pa");
  if (has("prompt", "parameters", "workflow", "comfyui", "stable diffusion", "trainedalgorithmicmedia")) found.add("ai");
  if (has("midjourney", "openai", "chatgpt", "dall-e", "gemini", "firefly", "stability ai", "novelai")) found.add("tool");

  // Walk common metadata-bearing segments/chunks so binary marker names are detected even when
  // their payload is not printable text.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > bytes.length) break;
      const start = offset + 2;
      const segment = bytes.subarray(start, offset + length);
      if (marker === 0xe1) {
        if (includesBytes(segment, "Exif\u0000\u0000")) {
          found.add("exif");
          if (hasGpsSubIfd(segment)) found.add("gps");
        }
        if (includesBytes(segment, "http://ns.adobe.com/xap/1.0/")) found.add("xmp");
      }
      if (marker === 0xed) found.add("iptc");
      if (marker === 0xe2 && includesBytes(segment, "ICC_PROFILE")) found.add("icc");
      offset += length;
    }
  } else if (bytes.length > 12 && bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG") {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset, false);
      if (length > bytes.length - offset - 12) break;
      const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (name === "eXIf") {
        found.add("exif");
        if (hasGpsSubIfd(bytes.subarray(offset + 8, offset + 8 + length))) found.add("gps");
      }
      if (name === "iCCP") found.add("icc");
      if (["tEXt", "iTXt", "zTXt"].includes(name)) found.add("pngtext");
      offset += length + 12;
      if (name === "IEND") break;
    }
  } else if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const name = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      if (name === "EXIF") {
        found.add("exif");
        if (hasGpsSubIfd(bytes.subarray(offset + 8, offset + 8 + length))) found.add("gps");
      }
      if (name === "XMP ") found.add("xmp");
      if (name === "ICCP") found.add("icc");
      if (length > bytes.length - offset - 8) break;
      offset += 8 + length + (length % 2);
    }
  }

  if (found.has("pngtext")) {
    if (has("prompt", "parameters", "workflow", "stable diffusion", "trainedalgorithmicmedia")) found.add("ai");
    if (has("midjourney", "openai", "chatgpt", "dall-e", "gemini", "firefly")) found.add("tool");
  }
  return found;
}

export async function inspectImage(file: File): Promise<Finding[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const markers = inspectChunks(bytes);
  const definition: Array<Omit<Finding, "found">> = [
    { id: "exif", title: "Camera & device details", description: "EXIF camera, software, timestamp, or device markers." },
    { id: "gps", title: "Location data", description: "GPS coordinates or location-related text markers." },
    { id: "xmp", title: "Editing history", description: "XMP sidecar-style fields embedded in the image." },
    { id: "iptc", title: "Caption & copyright", description: "IPTC or Photoshop image-resource markers." },
    { id: "c2pa", title: "Content Credentials", description: "C2PA manifest or Content Credentials marker." },
    { id: "ai", title: "Prompts & generation settings", description: "Common AI prompt, settings, workflow, or model-tag text." },
    { id: "tool", title: "AI tool names", description: "Known generator names found in readable metadata text." },
    { id: "pngtext", title: "Hidden PNG text", description: "PNG text chunks that may contain comments or software details." },
    { id: "icc", title: "Color profile", description: "An embedded ICC profile marker; the browser will convert rendered colors during export." },
  ];
  return definition.map((item) => ({ ...item, found: markers.has(item.id) }));
}

export async function verifyDecodable(file: File): Promise<void> {
  if (typeof createImageBitmap === "undefined") throw new Error("This browser cannot decode images locally.");
  const bitmap = await createImageBitmap(file);
  bitmap.close();
}

export async function cleanImage(file: File, options: OutputOptions): Promise<Blob> {
  if (!isSupportedImage(file)) throw new Error("For now, MetaClean supports JPEG, PNG, and WebP images.");
  if (typeof createImageBitmap === "undefined") throw new Error("Use a recent browser with local image decoding support.");
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: options.keepColors ? "default" : "none" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: options.makeUnique });
    if (!context) throw new Error("Your browser could not create an image canvas.");
    context.drawImage(bitmap, 0, 0);
    if (options.makeUnique && canvas.width && canvas.height) {
      const pixel = context.getImageData(0, 0, 1, 1);
      pixel.data[0] = pixel.data[0] === 255 ? 254 : pixel.data[0] + 1;
      context.putImageData(pixel, 0, 0);
    }
    const type = supportedTypes.has(file.type) ? file.type : extensionType(file.name);
    const outputType = type === "image/jpeg" || type === "image/png" || type === "image/webp" ? type : "image/png";
    const quality = outputType === "image/jpeg" || outputType === "image/webp" ? 0.96 : undefined;
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The cleaned image could not be exported.")), outputType, quality);
    });
    return result;
  } finally {
    bitmap.close();
  }
}

function extensionType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : "image/png";
}

export type FilenameMode = "suffix" | "prefix" | "numbered" | "original";

export function buildNames(files: File[], mode: FilenameMode): string[] {
  const seen = new Map<string, number>();
  return files.map((file, index) => {
    const dot = file.name.lastIndexOf(".");
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot) : ".png";
    let candidate = mode === "suffix" ? `${stem}-clean${ext}`
      : mode === "prefix" ? `clean-${stem}${ext}`
      : mode === "numbered" ? `image-${String(index + 1).padStart(3, "0")}${ext}`
      : file.name;
    const key = candidate.toLocaleLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) candidate = `${stem} (${count})${ext}`;
    return candidate;
  });
}
