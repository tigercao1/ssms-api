import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateReferenceDto } from './update-reference.dto';

function errorsOn(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(UpdateReferenceDto, payload);
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }).map((e) => e.property);
}

describe('UpdateReferenceDto validation', () => {
  it('accepts name, sortOrder and isActive', () => {
    expect(
      errorsOn({ name: 'Whistler', sortOrder: 2, isActive: false }),
    ).toEqual([]);
  });

  it('rejects key because it is not editable', () => {
    expect(errorsOn({ key: 'location.other', isActive: true })).toEqual([
      'key',
    ]);
  });

  it('rejects an empty name, a negative sortOrder and a non-boolean isActive', () => {
    expect(
      errorsOn({ name: '', sortOrder: -1, isActive: 'no' }).sort(),
    ).toEqual(['isActive', 'name', 'sortOrder']);
  });
});
