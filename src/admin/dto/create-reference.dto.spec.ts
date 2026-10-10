import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateReferenceDto } from './create-reference.dto';

function errorsOn(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(CreateReferenceDto, payload);
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }).map((e) => e.property);
}

describe('CreateReferenceDto validation', () => {
  it('accepts an English name, a Chinese name, or both', () => {
    expect(errorsOn({ key: 'location.a', name: 'Whistler' })).toEqual([]);
    expect(errorsOn({ key: 'location.a', nameZh: '惠斯勒' })).toEqual([]);
    expect(
      errorsOn({ key: 'location.a', name: 'Whistler', nameZh: '惠斯勒' }),
    ).toEqual([]);
  });

  it('rejects an empty English name and over-long names', () => {
    expect(
      errorsOn({
        key: 'location.a',
        name: '',
        nameZh: 'x'.repeat(201),
      }).sort(),
    ).toEqual(['name', 'nameZh']);
  });

  it('still requires a key', () => {
    expect(errorsOn({ name: 'Whistler' })).toEqual(['key']);
  });
});
