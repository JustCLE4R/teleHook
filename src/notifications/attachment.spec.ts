import { toAttachment } from './attachment.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);

function upload(
  originalname: string,
  data: Buffer,
  mimetype = 'application/octet-stream',
): Express.Multer.File {
  return {
    originalname,
    buffer: data,
    mimetype,
    size: data.length,
  } as Express.Multer.File;
}

describe('toAttachment', () => {
  it('keeps the file name, contents and MIME type', async () => {
    const attachment = toAttachment(
      upload('top.txt', Buffer.from('load average: 9.87'), 'text/plain'),
      0,
    );

    expect(attachment.filename).toBe('top.txt');
    expect(attachment.isPhoto).toBe(false);
    expect(attachment.content.type).toBe('text/plain');
    await expect(attachment.content.text()).resolves.toBe('load average: 9.87');
  });

  it.each([
    ['PNG', PNG],
    ['JPEG', JPEG],
  ])('sends a %s image as a photo', (_format, data) => {
    expect(toAttachment(upload('chart', data), 0).isPhoto).toBe(true);
  });

  it.each([
    ['text with an image name', 'fake.png', Buffer.from('not an image')],
    ['a GIF', 'anim.gif', Buffer.from('GIF89a')],
    ['a WebP image', 'shot.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ')],
    ['a PDF', 'report.pdf', Buffer.from('%PDF-1.7')],
    ['a file shorter than any signature', 'a.png', Buffer.from([0x89])],
  ])('sends %s as a file', (_case, name, data) => {
    expect(toAttachment(upload(name, data, 'image/png'), 0).isPhoto).toBe(
      false,
    );
  });

  it("sends images larger than Telegram's 10 MB photo limit as files", () => {
    const limit = 10 * 1024 * 1024;
    const image = (size: number) =>
      Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]);

    expect(toAttachment(upload('a.png', image(limit)), 0).isPhoto).toBe(true);
    expect(toAttachment(upload('b.png', image(limit + 1)), 0).isPhoto).toBe(
      false,
    );
  });

  it('removes control characters, which could forge log lines', () => {
    expect(
      toAttachment(upload('a\r\n[ERROR] b\u0000.txt', Buffer.from('x')), 0)
        .filename,
    ).toBe('a[ERROR] b.txt');
  });

  it('names a file whose name is blank after cleaning by its position', () => {
    expect(toAttachment(upload(' \n ', Buffer.from('x')), 2).filename).toBe(
      'attachment-3',
    );
  });
});
