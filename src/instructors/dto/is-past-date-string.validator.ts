import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Validates that an ISO date string (`YYYY-MM-DD`) is strictly in the past.
 * Mirrors the DB CHECK `date_of_birth < current_date` so a non-past DOB is
 * rejected at the API boundary with a 400 (TESTING_STRATEGY.md § Profile).
 * Only runs when a value is supplied; pair with `@IsOptional()`.
 */
@ValidatorConstraint({ name: 'isPastDateString', async: false })
export class IsPastDateStringConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || value === undefined) {
      return true; // optional — absence handled by @IsOptional
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    const todayUtc = new Date();
    const todayMidnight = Date.UTC(
      todayUtc.getUTCFullYear(),
      todayUtc.getUTCMonth(),
      todayUtc.getUTCDate(),
    );
    return parsed.getTime() < todayMidnight;
  }

  defaultMessage(): string {
    return 'dateOfBirth must be a valid past date (YYYY-MM-DD)';
  }
}

export function IsPastDateString(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      validator: IsPastDateStringConstraint,
    });
  };
}
