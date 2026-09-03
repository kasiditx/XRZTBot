import { jest } from '@jest/globals';
import { ValidationError } from '../../src/domain/errors.js';
import {
  buildEvidenceInputLabel,
  buildEvidenceMethodPrompt,
  resolveEvidenceImages,
} from '../../src/infrastructure/discord/evidence-images.js';

const discordMediaLink = 'https://cdn.discordapp.com/attachments/123/456/proof.png?ex=abcdef&is=123456&hm=signature';

describe('Discord evidence images', () => {
  it('offers file upload and Discord Media Link as separate methods', () => {
    const payload = buildEvidenceMethodPrompt('attendance:proof_method:round-id', 'หลักฐานเช็กชื่อ').components[0]?.toJSON();

    expect(payload?.components[0]).toMatchObject({
      type: 3,
      custom_id: 'attendance:proof_method:round-id',
      options: [
        expect.objectContaining({ value: 'FILE' }),
        expect.objectContaining({ value: 'LINK' }),
      ],
    });
  });

  it('builds a required upload or link field for the selected method', () => {
    const file = buildEvidenceInputLabel({
      mode: 'FILE',
      fileCustomId: 'proof:file',
      linkCustomId: 'proof:link',
      maximumImages: 5,
      label: 'รูปหลักฐาน',
    }).toJSON();
    const link = buildEvidenceInputLabel({
      mode: 'LINK',
      fileCustomId: 'proof:file',
      linkCustomId: 'proof:link',
      maximumImages: 5,
      label: 'รูปหลักฐาน',
    }).toJSON();

    expect(file).toMatchObject({ component: { type: 19, min_values: 1, max_values: 5, required: true } });
    expect(link).toMatchObject({ component: { type: 4, custom_id: 'proof:link', required: true } });
  });

  it('downloads a Discord Media Link immediately and uses the actual response type and size', async () => {
    const fetcher = jest.fn(() => Promise.resolve(new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    })));

    const images = await resolveEvidenceImages({
      mode: 'LINK',
      uploadedFiles: [],
      mediaLinkText: discordMediaLink,
      maximumImages: 1,
      maximumBytesPerImage: 10 * 1_024 * 1_024,
      filenamePrefix: 'attendance-proof',
    }, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      new URL(discordMediaLink),
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(images).toEqual([expect.objectContaining({
      attachment: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
      size: 3,
      name: 'attendance-proof-1.png',
    })]);
  });

  it('rejects URLs outside Discord CDN before making a request', async () => {
    const fetcher = jest.fn<typeof fetch>(() => Promise.reject(new Error('unexpected request')));

    await expect(resolveEvidenceImages({
      mode: 'LINK',
      uploadedFiles: [],
      mediaLinkText: 'https://example.com/proof.png',
      maximumImages: 1,
      maximumBytesPerImage: 10 * 1_024 * 1_024,
      filenamePrefix: 'proof',
    }, fetcher)).rejects.toBeInstanceOf(ValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an expired Media Link and an oversized response', async () => {
    const expired = jest.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    await expect(resolveEvidenceImages({
      mode: 'LINK',
      uploadedFiles: [],
      mediaLinkText: discordMediaLink,
      maximumImages: 1,
      maximumBytesPerImage: 10,
      filenamePrefix: 'proof',
    }, expired)).rejects.toBeInstanceOf(ValidationError);

    const oversized = jest.fn(() => Promise.resolve(new Response(Uint8Array.from({ length: 11 }, () => 1), {
      headers: { 'content-type': 'image/png' },
    })));
    await expect(resolveEvidenceImages({
      mode: 'LINK',
      uploadedFiles: [],
      mediaLinkText: discordMediaLink,
      maximumImages: 1,
      maximumBytesPerImage: 10,
      filenamePrefix: 'proof',
    }, oversized)).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires one source and accepts multiple Media Links only one per line', async () => {
    await expect(resolveEvidenceImages({
      mode: 'LINK',
      uploadedFiles: [],
      mediaLinkText: '',
      maximumImages: 5,
      maximumBytesPerImage: 10,
      filenamePrefix: 'proof',
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(resolveEvidenceImages({
      mode: 'LINK',
      uploadedFiles: [],
      mediaLinkText: Array.from({ length: 6 }, () => discordMediaLink).join('\n'),
      maximumImages: 5,
      maximumBytesPerImage: 10,
      filenamePrefix: 'proof',
    })).rejects.toBeInstanceOf(ValidationError);
  });
});
