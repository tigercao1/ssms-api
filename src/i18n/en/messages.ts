import type { MessageCatalog } from '../messages.types';

/**
 * English (`en`) message catalog — the source of truth (PORTAL_I18N_PLAN.md).
 *
 * Every other language mirrors this shape; see `../zh-CN/messages.ts`. Add new
 * keys here first (and to {@link MessageCatalog}), then translate.
 */
export const en: MessageCatalog = {
  common: {
    appName: 'Snow School',
    portal: 'Instructor Portal',
    loading: 'Loading…',
    save: 'Save',
    cancel: 'Cancel',
    edit: 'Edit',
    delete: 'Delete',
    confirm: 'Confirm',
    back: 'Back',
    next: 'Next',
    submit: 'Submit',
    search: 'Search',
    yes: 'Yes',
    no: 'No',
    language: 'Language',
    languageEnglish: 'English',
    languageChinese: 'Simplified Chinese',
    statusPending: 'Pending review',
    statusApproved: 'Approved',
    statusRejected: 'Rejected',
    statusDeactivated: 'Deactivated',
  },
  auth: {
    signInTitle: 'Sign in',
    signUpTitle: 'Create your account',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    signInButton: 'Sign in',
    signUpButton: 'Sign up',
    signOut: 'Sign out',
    forgotPassword: 'Forgot your password?',
    verifyEmailTitle: 'Verify your email',
    verifyEmailBody:
      'We sent a verification link to your email. Please open it to activate your account.',
    resendVerification: 'Resend verification email',
    emailNotVerified: 'Please verify your email address to continue.',
  },
  profile: {
    title: 'My profile',
    displayName: 'Display name',
    bio: 'Bio',
    bioPlaceholder: 'Tell partners about your experience and teaching style…',
    preferredLanguage: 'Preferred language',
    dateOfBirth: 'Date of birth',
    certifications: 'Certifications',
    disciplines: 'Disciplines',
    teachingLocations: 'Teaching locations',
    courseLevels: 'Course levels',
    photo: 'Profile photo',
    uploadPhoto: 'Upload photo',
    saveSuccess: 'Your profile has been saved.',
    saveError: 'We could not save your profile. Please try again.',
  },
  error: {
    unauthorized: 'You must be signed in to do that.',
    forbidden: 'You do not have permission to perform this action.',
    notFound: 'The requested item could not be found.',
    validation: 'Some of the information provided is invalid.',
    conflict: 'This action conflicts with the current state of the record.',
    rateLimited: 'Too many requests. Please try again shortly.',
    internal: 'Something went wrong on our end. Please try again later.',
    emailNotVerified: 'Your email address has not been verified yet.',
    profileNotApproved: 'Your profile has not been approved yet.',
  },
  validation: {
    required: 'This field is required.',
    email: 'Please enter a valid email address.',
    minLength: 'Please enter at least {min} characters.',
    maxLength: 'Please enter no more than {max} characters.',
    invalidDate: 'Please enter a valid date.',
    invalidLanguage: 'Please choose a supported language.',
    invalidUuid: 'The provided identifier is not valid.',
  },
  emptyState: {
    noCertifications: 'No certifications added yet.',
    noDisciplines: 'No disciplines selected yet.',
    noLocations: 'No teaching locations selected yet.',
    noResults: 'No results found.',
  },
  notification: {
    approved: {
      subject: 'Your instructor profile has been approved',
      greeting: 'Hi',
      body: 'Good news — your instructor profile has been approved. You can now sign in to the portal and your profile is visible to partners.',
      reasonLabel: 'Reason',
      linkLabel: 'Portal',
      signoff: 'Thank you,\nThe Snow School Team',
    },
    rejected: {
      subject: 'Update on your instructor application',
      greeting: 'Hi',
      body: 'Thank you for your application. After review, your instructor profile was not approved at this time.',
      reasonLabel: 'Reason',
      linkLabel: 'Portal',
      signoff: 'Thank you,\nThe Snow School Team',
    },
    deactivated: {
      subject: 'Your instructor profile has been deactivated',
      greeting: 'Hi',
      body: 'Your instructor profile has been deactivated and is no longer visible to partners. Please contact the school if you believe this is a mistake.',
      reasonLabel: 'Reason',
      linkLabel: 'Portal',
      signoff: 'Thank you,\nThe Snow School Team',
    },
  },
};

export default en;
