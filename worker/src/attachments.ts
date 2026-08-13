/**
 * Validation for ticket screenshot uploads, ported from app/attachments.py.
 *
 * The bytes go to R2 under a random key rather than to a public path, so every
 * read still goes through a route that can check who is asking — see the
 * /tickets/attachments/:id handler in src/routes/client.tsx.
 */

// A browser sends the type it inferred from the file extension, so it says
// nothing about the actual content. The real type is read from the leading
// bytes and that is what gets stored and served back.
//
// SVG is deliberately unsupported: it is a document format that can carry
// script, not a screenshot format, and serving one back to an admin would be a
// stored-XSS vector.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

export const ACCEPTED_LABEL = "PNG, JPEG, GIF, or WebP";
/** Mirrors the sniffed formats; used for the file input's accept attribute. */
export const ACCEPT_ATTRIBUTE = "image/png,image/jpeg,image/gif,image/webp";

/** A rejected upload. The message is written to be shown to the client. */
export class AttachmentError extends Error {}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** The image MIME type implied by the leading bytes, or null. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "image/gif";
  // RIFF....WEBP — four size bytes sit between the two markers.
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
}

/**
 * Reduce a client-supplied name to a plain display label.
 *
 * The name is never used to build the R2 key, but it is rendered back to the
 * client and to admins, so it is stripped of directory components and of
 * anything that would read as markup even before the view layer escapes it.
 */
export function cleanFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return (safe || "screenshot").slice(0, 120);
}

export interface ValidatedImage {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Validate one upload against the size cap and the format allowlist.
 *
 * The size is checked before the bytes are pulled into memory, so an oversized
 * file is rejected on its length rather than buffered first.
 */
export async function readImage(
  file: File,
  options: { maxBytes: number; label: string },
): Promise<ValidatedImage> {
  const { maxBytes, label } = options;

  if (file.size === 0) {
    throw new AttachmentError(`${label} is empty.`);
  }

  if (file.size > maxBytes) {
    throw new AttachmentError(
      `${label} is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB. ` +
        "Crop it or save it at a lower quality.",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (contentType === null) {
    throw new AttachmentError(
      `${label} is not an image the app recognises. Attach a ${ACCEPTED_LABEL} file.`,
    );
  }

  return { filename: label, contentType, bytes };
}

/**
 * Validate every chosen screenshot on a submission.
 *
 * Submitting the form without picking a file still sends one part for the
 * input, with a blank filename and zero size. Those are dropped here before
 * anything is counted or read.
 */
export async function collectScreenshots(
  files: File[],
  options: { maxBytes: number; maxCount: number },
): Promise<ValidatedImage[]> {
  const chosen = files.filter((file) => (file.name ?? "").trim() !== "" && file.size > 0);
  if (chosen.length === 0) return [];

  if (chosen.length > options.maxCount) {
    throw new AttachmentError(
      `Attach at most ${options.maxCount} screenshots. You selected ${chosen.length}.`,
    );
  }

  const images: ValidatedImage[] = [];
  for (const file of chosen) {
    images.push(
      await readImage(file, {
        maxBytes: options.maxBytes,
        label: cleanFilename(file.name ?? ""),
      }),
    );
  }
  return images;
}
