import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseStorageClient } from './storage-client';

class FakeBucket {
  constructor(
    private readonly signResult: {
      data: { signedUrl: string; token: string; path: string } | null;
      error: { message: string } | null;
    },
    private readonly publicUrl: string,
  ) {}
  createSignedUploadUrl(path: string) {
    return Promise.resolve(
      this.signResult.data
        ? { data: { ...this.signResult.data, path }, error: null }
        : this.signResult,
    );
  }
  getPublicUrl(path: string) {
    return { data: { publicUrl: `${this.publicUrl}/${path}` } };
  }
}

function makeClient(bucket: FakeBucket) {
  const supabase = { storage: { from: () => bucket } };
  return new SupabaseStorageClient(supabase as never);
}

describe('SupabaseStorageClient', () => {
  it('createSignedUploadUrl returns the signed url', async () => {
    const client = makeClient(
      new FakeBucket(
        {
          data: { signedUrl: 'https://up', token: 'tok', path: '' },
          error: null,
        },
        'https://pub',
      ),
    );
    await expect(
      client.createSignedUploadUrl('instructor-public', 'inst-1/avatar.jpg'),
    ).resolves.toEqual({
      signedUrl: 'https://up',
      token: 'tok',
      path: 'inst-1/avatar.jpg',
    });
  });

  it('createSignedUploadUrl throws on a storage error', async () => {
    const client = makeClient(
      new FakeBucket(
        { data: null, error: { message: 'denied' } },
        'https://pub',
      ),
    );
    await expect(
      client.createSignedUploadUrl('instructor-public', 'inst-1/avatar.jpg'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('getPublicUrl returns the public url', () => {
    const client = makeClient(
      new FakeBucket({ data: null, error: null }, 'https://pub'),
    );
    expect(client.getPublicUrl('instructor-public', 'inst-1/avatar.jpg')).toBe(
      'https://pub/inst-1/avatar.jpg',
    );
  });
});
