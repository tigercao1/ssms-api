import sharp from 'sharp';

export const MAX_IMAGE_DIMENSION = 2000;
export const COMPRESSED_IMAGE_TYPE = 'image/jpeg';
export const COMPRESSED_IMAGE_QUALITY = 85;

export interface CompressedPhoto {
  bytes: Buffer;
  contentType: typeof COMPRESSED_IMAGE_TYPE;
  width: number;
  height: number;
}

export async function compressPhoto(input: Buffer): Promise<CompressedPhoto> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: COMPRESSED_IMAGE_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    contentType: COMPRESSED_IMAGE_TYPE,
    width: info.width,
    height: info.height,
  };
}
