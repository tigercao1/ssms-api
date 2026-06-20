import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateInstructorProfileDto } from './update-instructor-profile.dto';

function validate(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateInstructorProfileDto, payload, {
    enableImplicitConversion: false,
  });
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
}

function errorsOn(payload: Record<string, unknown>): string[] {
  return validate(payload).map((e) => e.property);
}

describe('UpdateInstructorProfileDto validation (T3.2)', () => {
  it('accepts an empty patch (all fields optional)', () => {
    expect(validate({})).toHaveLength(0);
  });

  it('accepts a full valid patch', () => {
    expect(
      validate({
        displayNameEn: 'Jane Doe',
        displayNameZh: '简·多',
        bioEn: 'Instructor',
        bioZh: null,
        dateOfBirth: '1990-05-12',
        preferredLanguage: 'en',
        profilePhotoUrl: 'https://x/y.jpg',
        teachingLocationIds: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
        languageIds: ['3f2504e0-4f89-41d3-9a0c-0305e82c3302'],
        courseLevelOfferedIds: ['3f2504e0-4f89-41d3-9a0c-0305e82c3303'],
        certifications: [
          {
            org: 'csia',
            track: 'regular',
            level: 3,
            isPartial: true,
            partialComponents: ['ski'],
            achievedOn: '2022-03-14',
          },
        ],
        trainerStatus: [
          { discipline: 'ski', rookieSessionCompleted: true, trainerLevel: 2 },
        ],
      }),
    ).toHaveLength(0);
  });

  it('rejects empty displayNameEn (cannot be blanked)', () => {
    expect(errorsOn({ displayNameEn: '' })).toContain('displayNameEn');
  });

  it('rejects displayNameEn > 100 chars', () => {
    expect(errorsOn({ displayNameEn: 'a'.repeat(101) })).toContain(
      'displayNameEn',
    );
  });

  it('rejects displayNameZh > 100 chars', () => {
    expect(errorsOn({ displayNameZh: 'a'.repeat(101) })).toContain(
      'displayNameZh',
    );
  });

  it('rejects bioEn / bioZh > 1000 chars', () => {
    expect(errorsOn({ bioEn: 'a'.repeat(1001) })).toContain('bioEn');
    expect(errorsOn({ bioZh: 'a'.repeat(1001) })).toContain('bioZh');
  });

  it('rejects a non-past dateOfBirth', () => {
    expect(errorsOn({ dateOfBirth: '2999-01-01' })).toContain('dateOfBirth');
  });

  it('rejects a malformed dateOfBirth', () => {
    expect(errorsOn({ dateOfBirth: '05/12/1990' })).toContain('dateOfBirth');
  });

  it('rejects an invalid preferredLanguage', () => {
    expect(errorsOn({ preferredLanguage: 'fr' })).toContain(
      'preferredLanguage',
    );
  });

  it('rejects non-uuid relation ids', () => {
    expect(errorsOn({ teachingLocationIds: ['not-a-uuid'] })).toContain(
      'teachingLocationIds',
    );
  });

  it('rejects email (not a whitelisted field)', () => {
    expect(errorsOn({ email: 'new@example.com' })).toContain('email');
  });

  it('rejects forbidden disciplineIds / cert id fields', () => {
    const props = errorsOn({
      disciplineIds: ['x'],
      csiaCertificationIds: ['y'],
    });
    expect(props).toEqual(
      expect.arrayContaining(['disciplineIds', 'csiaCertificationIds']),
    );
  });

  it('rejects an invalid cert org/track', () => {
    expect(
      validate({
        certifications: [{ org: 'psia', track: 'slalom', level: 3 }],
      }).length,
    ).toBeGreaterThan(0);
  });
});
