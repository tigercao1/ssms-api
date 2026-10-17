import { DocumentExportOwner, exportOwnerId } from './document-export-owner';

describe('export owner id', () => {
  it('is the Fly machine id plus a random suffix per process', () => {
    expect(exportOwnerId('148e21ea7')).toMatch(/^148e21ea7-[0-9a-f]{8}$/);
    expect(exportOwnerId(undefined)).toMatch(/^local-[0-9a-f]{8}$/);
    expect(exportOwnerId('  ')).toMatch(/^local-/);
    expect(exportOwnerId('m')).not.toBe(exportOwnerId('m'));
  });

  it('reads FLY_MACHINE_ID', () => {
    const previous = process.env.FLY_MACHINE_ID;
    process.env.FLY_MACHINE_ID = 'abc123';
    try {
      expect(new DocumentExportOwner().id).toMatch(/^abc123-/);
    } finally {
      if (previous === undefined) {
        delete process.env.FLY_MACHINE_ID;
      } else {
        process.env.FLY_MACHINE_ID = previous;
      }
    }
  });
});
