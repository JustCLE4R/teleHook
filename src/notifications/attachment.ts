/** A file sent to each chat after the message. */
export interface Attachment {
  /** Shown in Telegram: as the caption of a photo, or the name of a file. */
  readonly filename: string;
  readonly content: Blob;
  /** A JPEG or PNG that Telegram can show inline; anything else is a file. */
  readonly isPhoto: boolean;
}

/** Telegram's size limit for photos; larger images are sent as files. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Leading bytes of the image formats that are sent as photos. */
const PHOTO_SIGNATURES = [
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
];

/** Converts the upload at `index` (0-based, in request order). */
export function toAttachment(
  file: Express.Multer.File,
  index: number,
): Attachment {
  const data = file.buffer;
  return {
    filename: cleanFilename(file.originalname) || `attachment-${index + 1}`,
    // Converted once here rather than for each chat; Blob copies the bytes.
    // multer's memory storage never backs a buffer with shared memory.
    content: new Blob([data as Uint8Array<ArrayBuffer>], {
      type: file.mimetype,
    }),
    // Detected from the content because the client's MIME type is a guess.
    isPhoto:
      data.length <= MAX_PHOTO_BYTES &&
      PHOTO_SIGNATURES.some((signature) =>
        data.subarray(0, signature.length).equals(signature),
      ),
  };
}

/**
 * File names come from the client and are logged when a delivery fails, so
 * control characters, which could forge log lines, are removed.
 */
function cleanFilename(name: string): string {
  return name.replace(/\p{Cc}/gu, '').trim();
}
