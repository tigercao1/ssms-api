/* eslint-disable */
export default async () => {
  const t = {
    ['../instructors/dto/certification.dto']: require('../instructors/dto/certification.dto'),
    ['../instructors/dto/trainer-status.dto']: require('../instructors/dto/trainer-status.dto'),
    ['../documents/dto/template.dto']: require('../documents/dto/template.dto'),
    ['../documents/dto/form.dto']: require('../documents/dto/form.dto'),
    ['../booking/dto/booking.dto']: require('../booking/dto/booking.dto'),
    ['../insurance/dto/insurance.dto']: require('../insurance/dto/insurance.dto'),
    ['../class-import/dto/class-import.dto']: require('../class-import/dto/class-import.dto'),
  };
  return {
    '@nestjs/swagger': {
      models: [
        [
          require('../instructors/dto/bio-draft.dto'),
          {
            BioDraftDto: {
              text: {
                required: true,
                type: () => String,
                maxLength: 2000,
                pattern: '\\S',
              },
              mode: { required: true, enum: ['refine', 'translate'] },
            },
          },
        ],
        [
          require('../instructors/dto/certification.dto'),
          {
            CertificationDto: {
              org: { required: true, enum: ['csia', 'casi'] },
              track: { required: true, enum: ['regular', 'park', 'carving'] },
              level: {
                required: true,
                type: () => Number,
                minimum: 1,
                maximum: 4,
              },
              isPartial: { required: false, type: () => Boolean },
              partialComponents: {
                required: false,
                type: () => [String],
                uniqueItems: true,
              },
              achievedOn: {
                required: false,
                type: () => String,
                nullable: true,
                description:
                  'ISO date (YYYY-MM-DD) when the highest level was reached.',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              },
            },
          },
        ],
        [
          require('../instructors/dto/trainer-status.dto'),
          {
            TrainerStatusDto: {
              discipline: { required: true, enum: ['ski', 'snowboard'] },
              rookieSessionCompleted: { required: false, type: () => Boolean },
              trainerExamPassed: {
                required: false,
                type: () => Boolean,
                description: 'CSIA only; informational for CASI.',
              },
              trainerLevel: {
                required: false,
                type: () => Number,
                nullable: true,
                description:
                  '1..4; null/omitted = not officially a trainer for this discipline.',
                minimum: 1,
                maximum: 4,
              },
            },
          },
        ],
        [
          require('../instructors/dto/update-instructor-profile.dto'),
          {
            UpdateInstructorProfileDto: {
              displayNameEn: {
                required: false,
                type: () => String,
                description:
                  'Required for display; once set it cannot be blanked. Optional in a PATCH,\nbut when provided must be a non-empty, \u2264100-char string.',
                maxLength: 100,
              },
              firstName: {
                required: false,
                type: () => String,
                maxLength: 100,
                pattern: '\\S',
              },
              lastName: {
                required: false,
                type: () => String,
                maxLength: 100,
                pattern: '\\S',
              },
              displayNameZh: {
                required: false,
                type: () => String,
                nullable: true,
                maxLength: 100,
              },
              bioEn: {
                required: false,
                type: () => String,
                nullable: true,
                maxLength: 1000,
              },
              bioZh: {
                required: false,
                type: () => String,
                nullable: true,
                maxLength: 1000,
              },
              dateOfBirth: {
                required: false,
                type: () => String,
                nullable: true,
                description:
                  'ISO date (YYYY-MM-DD); must be a past date (re-checked in the DB CHECK).',
              },
              preferredLanguage: { required: false, enum: ['en', 'zh-CN'] },
              profilePhotoUrl: {
                required: false,
                type: () => String,
                nullable: true,
                description:
                  'Public URL produced by our signed-upload flow (MediaService).',
              },
              minStudentAge: {
                required: false,
                type: () => Number,
                minimum: 0,
                maximum: 18,
              },
              teachingLocationIds: {
                required: false,
                type: () => [String],
                format: 'uuid',
              },
              languageIds: {
                required: false,
                type: () => [String],
                format: 'uuid',
              },
              courseLevelOfferedIds: {
                required: false,
                type: () => [String],
                format: 'uuid',
              },
              certifications: {
                required: false,
                type: () => [
                  t['../instructors/dto/certification.dto'].CertificationDto,
                ],
              },
              trainerStatus: {
                required: false,
                type: () => [
                  t['../instructors/dto/trainer-status.dto'].TrainerStatusDto,
                ],
              },
            },
          },
        ],
        [
          require('../instructors/dto/update-own-instructor-profile.dto'),
          {
            UpdateOwnInstructorProfileDto: {
              bioEnMachineTranslated: { required: false, type: () => Boolean },
              bioZhMachineTranslated: { required: false, type: () => Boolean },
            },
          },
        ],
        [
          require('../media/dto/photo-upload-request.dto'),
          {
            PhotoUploadRequestDto: {
              contentType: {
                required: true,
                enum: ['image/jpeg', 'image/png', 'image/webp'],
              },
              contentLength: { required: true, type: () => Number, minimum: 1 },
              slot: { required: false, enum: [1, 2, 3] },
            },
          },
        ],
        [
          require('../media/dto/photo-confirm.dto'),
          {
            PhotoConfirmDto: {
              contentType: {
                required: true,
                enum: ['image/jpeg', 'image/png', 'image/webp'],
              },
              slot: { required: false, enum: [1, 2, 3] },
            },
          },
        ],
        [
          require('../documents/dto/certification-upload.dto'),
          {
            CertificationUploadUrlDto: {
              org: { required: true, enum: ['csia', 'casi'] },
              track: { required: true, enum: ['regular', 'park', 'carving'] },
              validUntil: { required: true, type: () => String },
              contentType: {
                required: true,
                enum: [
                  'image/jpeg',
                  'image/png',
                  'image/webp',
                  'application/pdf',
                ],
              },
              contentLength: { required: true, type: () => Number, minimum: 1 },
            },
            ReviewCertificationUploadDto: {
              reviewStatus: {
                required: true,
                enum: ['pending', 'approved', 'rejected'],
              },
              reviewNote: {
                required: false,
                type: () => String,
                nullable: true,
              },
              validUntil: { required: false, type: () => String },
            },
          },
        ],
        [
          require('../documents/dto/document-review.dto'),
          {
            DocumentReviewsQueryDto: {
              status: { required: false, enum: ['pending', 'decided'] },
              page: { required: false, type: () => Number, minimum: 1 },
              limit: { required: false, type: () => Number, minimum: 1 },
            },
          },
        ],
        [
          require('../documents/dto/assignment.dto'),
          {
            CreateAssignmentsDto: {
              templateId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              season: { required: true, type: () => String },
              instructorIds: {
                required: false,
                type: () => [String],
                minItems: 1,
                format: 'uuid',
              },
              allActiveInstructors: { required: false, type: () => Boolean },
            },
          },
        ],
        [
          require('../documents/dto/template.dto'),
          {
            CreateTemplateDto: {
              kind: { required: true, enum: ['sign', 'read'] },
              audience: { required: true, enum: ['instructor', 'customer'] },
              titleEn: { required: true, type: () => String },
              titleZh: { required: false, type: () => String, nullable: true },
              descriptionEn: {
                required: false,
                type: () => String,
                nullable: true,
              },
              descriptionZh: {
                required: false,
                type: () => String,
                nullable: true,
              },
              required: { required: true, type: () => Boolean },
              sortOrder: { required: true, type: () => Number },
              sourceLanguage: {
                required: false,
                nullable: true,
                enum: ['en', 'zh'],
              },
            },
            UpdateTemplateDto: {
              titleEn: { required: false, type: () => String },
              titleZh: { required: false, type: () => String, nullable: true },
              descriptionEn: {
                required: false,
                type: () => String,
                nullable: true,
              },
              descriptionZh: {
                required: false,
                type: () => String,
                nullable: true,
              },
              required: { required: false, type: () => Boolean },
              sortOrder: { required: false, type: () => Number },
              sourceLanguage: {
                required: false,
                nullable: true,
                enum: ['en', 'zh'],
              },
            },
            SourceUploadUrlDto: {
              contentLength: { required: true, type: () => Number, minimum: 1 },
            },
            TemplateFieldDto: {
              id: { required: true, type: () => String },
              type: {
                required: true,
                enum: [
                  'date',
                  'text',
                  'signature',
                  'initials',
                  'full_name',
                  'checkbox',
                ],
              },
              page: { required: true, type: () => Number, minimum: 1 },
              x: { required: true, type: () => Number },
              y: { required: true, type: () => Number },
              w: { required: true, type: () => Number, minimum: 1 },
              h: { required: true, type: () => Number, minimum: 1 },
              required: { required: true, type: () => Boolean },
              labelEn: { required: true, type: () => String },
              labelZh: { required: false, type: () => String, nullable: true },
              prefill: {
                required: false,
                nullable: true,
                enum: ['email', 'full_name', 'date_signed'],
              },
            },
            PutTemplateFieldsDto: {
              fields: {
                required: true,
                type: () => [
                  t['../documents/dto/template.dto'].TemplateFieldDto,
                ],
              },
            },
            PublishTemplateDto: {
              assignTo: { required: true, enum: ['all', 'selected'] },
              season: { required: false, type: () => String },
              instructorIds: {
                required: false,
                type: () => [String],
                format: 'uuid',
              },
            },
            ChangeAudienceDto: {
              assignTo: { required: true, enum: ['all', 'selected'] },
            },
            PublishPreviewQueryDto: {
              season: { required: false, type: () => String },
            },
          },
        ],
        [
          require('../documents/dto/complete-document.dto'),
          {
            CompleteDocumentDto: {
              acknowledged: { required: false, type: () => Boolean },
              consent: { required: false, type: () => Boolean },
              signerName: { required: false, type: () => String },
              values: {
                required: false,
                type: 'object',
                additionalProperties: true,
              },
              signatures: {
                required: false,
                type: 'object',
                additionalProperties: true,
              },
              language: { required: false, nullable: true, enum: ['en', 'zh'] },
            },
            OpenDocumentQueryDto: {
              language: { required: false, enum: ['en', 'zh'] },
            },
          },
        ],
        [
          require('../documents/dto/export.dto'),
          {
            TemplateAssignmentsQueryDto: {
              season: { required: false, type: () => String },
              status: { required: false, enum: ['completed', 'all', 'open'] },
              q: { required: false, type: () => String, maxLength: 200 },
              hasSignedCopy: {
                required: false,
                type: () => Boolean,
                description:
                  '`true`: only rows with a signed copy, so `X-Total-Count` counts exportable copies.',
              },
              page: { required: false, type: () => Number, minimum: 1 },
              limit: { required: false, type: () => Number, minimum: 1 },
            },
            CreateDocumentExportDto: {
              season: { required: false, type: () => String },
              assignmentIds: {
                required: false,
                type: () => [String],
                format: 'uuid',
                minItems: 1,
              },
            },
          },
        ],
        [
          require('../documents/dto/form.dto'),
          {
            CreateFormDto: {
              slug: { required: true, type: () => String, maxLength: 60 },
              titleEn: { required: true, type: () => String },
              titleZh: { required: false, type: () => String, nullable: true },
            },
            UpdateFormDto: {
              titleEn: { required: false, type: () => String },
              titleZh: { required: false, type: () => String, nullable: true },
            },
            FormFieldDto: {
              key: { required: true, type: () => String },
              type: {
                required: true,
                enum: ['email', 'date', 'text', 'signature'],
              },
              label: { required: true, type: () => String },
              required: { required: true, type: () => Boolean },
            },
            SaveFormDraftDto: {
              title: { required: true, type: () => String },
              bodyMarkdown: { required: true, type: () => String },
              fields: {
                required: false,
                type: () => [t['../documents/dto/form.dto'].FormFieldDto],
                minItems: 1,
              },
            },
            SignatureLookupQueryDto: {
              q: { required: true, type: () => String, minLength: 2 },
            },
            StudentSignaturesQueryDto: {
              q: { required: false, type: () => String },
            },
          },
        ],
        [
          require('../documents/dto/complete-form.dto'),
          {
            CompleteFormDto: {
              lang: { required: true, enum: ['en', 'zh'] },
              version: { required: true, type: () => Number, minimum: 1 },
              answers: {
                required: true,
                type: 'object',
                additionalProperties: true,
              },
              signatures: {
                required: false,
                type: 'object',
                additionalProperties: true,
              },
              consent: { required: true, type: () => Boolean },
            },
            FormQueryDto: { lang: { required: false, enum: ['en', 'zh'] } },
          },
        ],
        [
          require('../activation/dto/redeem-activation.dto'),
          {
            RedeemActivationDto: {
              token: { required: true, type: () => String, maxLength: 256 },
            },
          },
        ],
        [
          require('../activation/dto/resend-activation.dto'),
          {
            ResendActivationDto: {
              email: {
                required: true,
                type: () => String,
                maxLength: 254,
                format: 'email',
              },
            },
          },
        ],
        [
          require('../shopify-sync/dto/run-shopify-sync.dto'),
          {
            RunShopifySyncDto: {
              instructorId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
            },
          },
        ],
        [
          require('../shopify-sync/dto/update-shopify-sync.dto'),
          {
            UpdateShopifySyncDto: {
              enabled: { required: true, type: () => Boolean },
            },
          },
        ],
        [
          require('./dto/create-reference.dto'),
          {
            CreateReferenceDto: {
              key: { required: true, type: () => String, maxLength: 100 },
              name: { required: false, type: () => String, maxLength: 200 },
              nameZh: { required: false, type: () => String, maxLength: 200 },
              sortOrder: {
                required: false,
                type: () => Number,
                description:
                  'Lower sorts first; defaults to 0 to match the column default.',
                minimum: 0,
              },
              isActive: {
                required: false,
                type: () => Boolean,
                description:
                  'Defaults to true (visible in public reference reads).',
              },
            },
          },
        ],
        [
          require('./dto/list-instructors-query.dto'),
          {
            InstructorFiltersQueryDto: {
              status: {
                required: false,
                description: 'Narrow by approval workflow state.',
                enum: ['pending', 'approved', 'rejected'],
              },
              stage: {
                required: false,
                type: () => [Object],
                enum: [
                  'pending',
                  'rejected',
                  'deactivated',
                  'live',
                  'onboarding',
                  'in_review',
                  'going_live',
                ],
                isArray: true,
              },
              active: {
                required: false,
                type: () => Boolean,
                description:
                  'Narrow by active flag. Accepts `true`/`false` (string or boolean).',
              },
              calendarConnected: { required: false, type: () => Boolean },
              q: { required: false, type: () => String, maxLength: 200 },
              onboarding: { required: false, enum: ['complete', 'incomplete'] },
            },
            ListInstructorsQueryDto: {
              page: { required: false, type: () => Number, minimum: 1 },
              limit: { required: false, type: () => Number, minimum: 1 },
            },
          },
        ],
        [
          require('./dto/update-instructor-email.dto'),
          {
            UpdateInstructorEmailDto: {
              email: {
                required: true,
                type: () => String,
                maxLength: 254,
                format: 'email',
              },
              expectedCurrentEmail: {
                required: true,
                type: () => String,
                maxLength: 320,
              },
            },
          },
        ],
        [
          require('../seasons/dto/season.dto'),
          {
            CreateSeasonDto: {
              key: { required: true, type: () => String },
              startsOn: { required: true, type: () => String },
              endsOn: { required: true, type: () => String },
            },
            UpdateSeasonDto: {
              startsOn: { required: false, type: () => String },
              endsOn: { required: false, type: () => String },
            },
          },
        ],
        [
          require('./dto/update-reference.dto'),
          {
            UpdateReferenceDto: {
              name: { required: false, type: () => String, maxLength: 200 },
              nameZh: {
                required: false,
                type: () => String,
                nullable: true,
                maxLength: 200,
              },
              sortOrder: { required: false, type: () => Number, minimum: 0 },
              isActive: { required: false, type: () => Boolean },
            },
          },
        ],
        [
          require('./dto/update-activation.dto'),
          {
            UpdateActivationDto: {
              isActive: { required: true, type: () => Boolean },
            },
          },
        ],
        [
          require('./dto/update-approval-status.dto'),
          {
            UpdateApprovalStatusDto: {
              approvalStatus: {
                required: true,
                enum: ['approved', 'rejected'],
              },
              reason: { required: false, type: () => String, maxLength: 500 },
            },
          },
        ],
        [
          require('./dto/update-display-order.dto'),
          {
            UpdateDisplayOrderDto: {
              displayOrder: {
                required: true,
                type: () => Number,
                nullable: true,
                minimum: 0,
                maximum: 2147483647,
              },
            },
          },
        ],
        [
          require('./dto/update-role.dto'),
          {
            UpdateRoleDto: {
              role: { required: true, enum: ['admin', 'instructor'] },
            },
          },
        ],
        [
          require('../public-api/dto/list-instructors-query.dto'),
          {
            ListInstructorsQueryDto: {
              locale: { required: true, default: 'en', enum: ['en', 'zh-CN'] },
              page: {
                required: true,
                type: () => Object,
                default: 1,
                minimum: 1,
              },
              location: { required: false, type: () => [String] },
              language: { required: false, type: () => [String] },
              discipline: {
                required: false,
                type: () => [Object],
                enum: ['ski', 'snowboard'],
                isArray: true,
              },
              min_csia_level: {
                required: false,
                type: () => Number,
                minimum: 1,
                maximum: 4,
              },
              min_casi_level: {
                required: false,
                type: () => Number,
                minimum: 1,
                maximum: 4,
              },
              trainers_only: {
                required: true,
                type: () => Object,
                default: false,
              },
              sort: {
                required: true,
                default: 'name',
                enum: ['name', 'seniority'],
              },
              order: { required: false, enum: ['asc', 'desc'] },
            },
          },
        ],
        [
          require('../public-pages/dto/create-public-page.dto'),
          {
            CreatePublicPageDto: {
              slug: { required: true, type: () => String, minLength: 1 },
              title: {
                required: true,
                type: () => String,
                minLength: 1,
                pattern: '\\S',
              },
            },
          },
        ],
        [
          require('../public-pages/dto/update-public-page.dto'),
          {
            UpdatePublicPageDto: {
              title: {
                required: true,
                type: () => String,
                minLength: 1,
                pattern: '\\S',
              },
            },
          },
        ],
        [
          require('../google/dto/freebusy-query.dto'),
          {
            FreeBusyQueryDto: {
              calendarIds: {
                required: true,
                type: () => [String],
                maxLength: 1024,
                minItems: 1,
              },
              from: { required: true, type: () => String },
              to: { required: true, type: () => String },
            },
          },
        ],
        [
          require('../lessons/dto/list-classes-query.dto'),
          {
            ListClassesQueryDto: {
              from: { required: false, type: () => String },
              to: { required: false, type: () => String },
              instructorId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              page: { required: false, type: () => Number, minimum: 1 },
              limit: { required: false, type: () => Number, minimum: 1 },
            },
          },
        ],
        [
          require('../lessons/dto/update-google-calendar.dto'),
          {
            UpdateGoogleCalendarDto: {
              googleCalendarId: {
                required: true,
                type: () => String,
                nullable: true,
                minLength: 1,
                pattern: '^\\S+$',
              },
              matchStatus: {
                required: false,
                enum: ['suggested', 'confirmed'],
              },
            },
          },
        ],
        [
          require('../lessons/dto/lesson-type.dto'),
          {
            CreateLessonTypeDto: {
              nameEn: { required: true, type: () => String },
              nameZh: { required: false, type: () => String, nullable: true },
              groupSize: {
                required: false,
                type: () => Number,
                nullable: true,
                minimum: 1,
              },
              durationMin: { required: true, type: () => Number, minimum: 1 },
              isPromo: { required: false, type: () => Boolean },
              active: { required: false, type: () => Boolean },
              sortOrder: { required: false, type: () => Number },
            },
            UpdateLessonTypeDto: {
              nameEn: { required: false, type: () => String },
              nameZh: { required: false, type: () => String, nullable: true },
              groupSize: {
                required: false,
                type: () => Number,
                nullable: true,
                minimum: 1,
              },
              durationMin: { required: false, type: () => Number, minimum: 1 },
              isPromo: { required: false, type: () => Boolean },
              active: { required: false, type: () => Boolean },
              sortOrder: { required: false, type: () => Number },
            },
            ListLessonTypesQueryDto: {
              active: { required: false, type: () => Boolean },
            },
          },
        ],
        [
          require('../lessons/dto/pay-rate.dto'),
          {
            CreatePayRateDto: {
              lessonTypeId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              instructorId: {
                required: false,
                type: () => String,
                nullable: true,
                format: 'uuid',
              },
              hourlyRate: { required: true, type: () => Number, minimum: 0 },
              rateUnit: { required: false, enum: ['day', 'hour'] },
              currency: {
                required: false,
                type: () => String,
                pattern: '^[A-Z]{3}$',
              },
              effectiveFrom: { required: true, type: () => String },
              effectiveTo: {
                required: false,
                type: () => String,
                nullable: true,
              },
            },
            UpdatePayRateDto: {
              hourlyRate: { required: false, type: () => Number, minimum: 0 },
              rateUnit: { required: false, enum: ['day', 'hour'] },
              currency: {
                required: false,
                type: () => String,
                pattern: '^[A-Z]{3}$',
              },
              effectiveFrom: { required: false, type: () => String },
              effectiveTo: {
                required: false,
                type: () => String,
                nullable: true,
              },
            },
            ListPayRatesQueryDto: {
              lessonTypeId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              instructorId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              scope: { required: false, enum: ['default', 'override'] },
            },
            ResolvePayRateQueryDto: {
              instructorId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              lessonTypeId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              date: { required: true, type: () => String },
            },
          },
        ],
        [
          require('../customers/dto/customers.dto'),
          {
            SearchCustomersQueryDto: {
              q: { required: false, type: () => String, maxLength: 200 },
              limit: { required: false, type: () => Number, minimum: 1 },
              page: { required: false, type: () => Number, minimum: 1 },
              includeDeleted: { required: false, type: () => Boolean },
            },
            CreateCustomerDto: {
              firstName: { required: true, type: () => String },
              lastName: { required: true, type: () => String },
              email: {
                required: false,
                type: () => String,
                maxLength: 320,
                format: 'email',
              },
              phone: {
                required: false,
                type: () => String,
                pattern: '^\\+?[0-9][0-9 ().-]{5,24}$',
              },
            },
            SyncCustomersDto: {
              full: { required: false, type: () => Boolean },
              cursor: { required: false, type: () => String, maxLength: 1000 },
            },
          },
        ],
        [
          require('../booking/dto/booking.dto'),
          {
            AvailabilityQueryDto: {
              date: { required: true, type: () => String },
              lessonTypeId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              instructorIds: {
                required: false,
                type: () => [String],
                format: 'uuid',
              },
            },
            RepeatDto: {
              weekly: { required: true, type: () => Boolean },
              count: {
                required: true,
                type: () => Number,
                minimum: 2,
                maximum: 12,
              },
            },
            CreateBookingDto: {
              instructorId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              lessonTypeId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              startsAt: { required: true, type: () => String },
              customerIds: {
                required: true,
                type: () => [String],
                uniqueItems: true,
                format: 'uuid',
                minItems: 1,
              },
              locationId: {
                required: false,
                type: () => String,
                nullable: true,
                format: 'uuid',
              },
              notes: { required: false, type: () => String, nullable: true },
              repeat: {
                required: false,
                type: () => t['../booking/dto/booking.dto'].RepeatDto,
              },
              status: {
                required: false,
                enum: ['completed', 'scheduled', 'no_show'],
              },
              addToCalendar: { required: false, type: () => Boolean },
            },
            UpdateBookingDto: {
              startsAt: { required: false, type: () => String },
              instructorId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              lessonTypeId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              customerIds: {
                required: false,
                type: () => [String],
                uniqueItems: true,
                format: 'uuid',
                minItems: 1,
              },
              notes: { required: false, type: () => String, nullable: true },
            },
            SetClassStatusDto: {
              status: {
                required: true,
                enum: ['completed', 'scheduled', 'no_show'],
              },
            },
            BookingSettingsDto: {
              dayStartTime: { required: true, type: () => String },
              dayEndTime: { required: true, type: () => String },
              slotMinutes: { required: true, type: () => Number },
              weekdayOverrides: {
                required: false,
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        ],
        [
          require('../payroll/dto/payroll.dto'),
          {
            ListPayrollPeriodsQueryDto: {
              around: { required: false, type: () => String },
            },
            UpdatePayrollSettingsDto: {
              anchorDate: { required: true, type: () => String },
            },
            CreatePayrollAdjustmentDto: {
              instructorId: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
              description: {
                required: true,
                type: () => String,
                maxLength: 500,
              },
              currency: {
                required: false,
                type: () => String,
                pattern: '^[A-Z]{3}$',
              },
            },
            FinalizePayrollPeriodDto: {
              acceptZeroRate: { required: false, type: () => Boolean },
            },
            ExportPayrollQueryDto: {
              detail: { required: false, enum: ['0', '1'] },
            },
          },
        ],
        [
          require('../insurance/dto/insurance.dto'),
          {
            InsuranceSeasonQueryDto: {
              season: { required: false, type: () => String },
            },
            InsuranceStudentDto: {
              name: { required: true, type: () => String, maxLength: 200 },
              waiverConfirmed: { required: true, type: () => Boolean },
            },
            RegisterLessonDto: {
              lessonDate: { required: true, type: () => String },
              durationHours: { required: true, enum: [1, 2] },
              locationId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              locationOther: {
                required: false,
                type: () => String,
                maxLength: 200,
              },
              students: {
                required: true,
                type: () => [
                  t['../insurance/dto/insurance.dto'].InsuranceStudentDto,
                ],
                minItems: 1,
              },
              topUp: { required: false, type: () => Boolean },
              idempotencyKey: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
            },
            RequestLessonDto: {
              lessonDate: { required: true, type: () => String },
              durationHours: { required: true, enum: [1, 2] },
              locationId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              locationOther: {
                required: false,
                type: () => String,
                maxLength: 200,
              },
              students: {
                required: true,
                type: () => [
                  t['../insurance/dto/insurance.dto'].InsuranceStudentDto,
                ],
                minItems: 1,
              },
            },
            SubmitInsuranceRequestDto: {
              lessons: {
                required: true,
                type: () => [
                  t['../insurance/dto/insurance.dto'].RequestLessonDto,
                ],
                minItems: 1,
              },
              idempotencyKey: {
                required: true,
                type: () => String,
                format: 'uuid',
              },
            },
            GrantSeasonPassDto: {
              season: { required: false, type: () => String },
              note: { required: false, type: () => String, maxLength: 500 },
              paidOn: { required: false, type: () => String },
            },
            AdminInsuranceRecordsQueryDto: {
              instructorId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              paymentStatus: {
                required: false,
                enum: ['paid', 'unpaid', 'not_required', 'voided'],
              },
              page: { required: false, type: () => Number, minimum: 1 },
              limit: { required: false, type: () => Number, minimum: 1 },
            },
            MarkPaidDto: {
              paidOn: { required: false, type: () => String },
              note: { required: false, type: () => String, maxLength: 500 },
            },
            VoidRecordDto: {
              reason: { required: true, type: () => String, maxLength: 500 },
            },
          },
        ],
        [
          require('../class-import/dto/class-import.dto'),
          {
            ClassImportQueryDto: {
              problem: {
                required: false,
                enum: [
                  'instructor_not_found',
                  'instructor_ambiguous',
                  'lesson_type_unmapped',
                  'invalid_row',
                  'duplicate_row',
                  'customer_not_found',
                  'already_imported',
                  'any',
                  'blocking',
                ],
              },
              page: { required: false, type: () => Number, minimum: 1 },
              limit: { required: false, type: () => Number, minimum: 1 },
            },
            UpdateClassImportRowDto: {
              instructorId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              lessonTypeId: {
                required: false,
                type: () => String,
                format: 'uuid',
              },
              customerId: {
                required: false,
                type: () => String,
                nullable: true,
                format: 'uuid',
              },
            },
            EventMapEntryDto: {
              eventName: { required: true, type: () => String, minLength: 1 },
              lessonTypeId: {
                required: true,
                type: () => String,
                nullable: true,
                format: 'uuid',
              },
            },
            SetEventMapDto: {
              mappings: {
                required: true,
                type: () => [
                  t['../class-import/dto/class-import.dto'].EventMapEntryDto,
                ],
                minItems: 1,
              },
            },
          },
        ],
      ],
      controllers: [],
    },
  };
};
