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
  email: {
    layout: {
      greeting: 'Hi {name},',
      greetingNoName: 'Hi there,',
      signoffLead: 'Warm regards,',
      signoffTeam: 'The Serendipity Snow Club team',
      buttonFallback:
        "If the button doesn't work, copy and paste this link into your browser:",
      buttonLine: '{label}: {url}',
      codeLabel: 'Or enter this code:',
      footerClub: 'Serendipity Snow Club',
      footerQuestions:
        'Questions? Reply to this email or write to info@ssnow.club',
    },
    approved: {
      subject: "You're approved: welcome to Serendipity Snow Club",
      preheader: 'Your instructor profile has been approved.',
      heading: 'Your profile is approved',
      paragraphs: [
        "Great news: we've reviewed your instructor profile and approved it. Welcome to the team!",
        'You can sign in to the instructor portal any time to keep your details, certifications and photos up to date.',
      ],
      button: 'Sign in',
      finePrint:
        "You're receiving this because you have an instructor profile with Serendipity Snow Club.",
    },
    rejected: {
      subject: 'An update on your instructor application',
      preheader: 'About your Serendipity Snow Club instructor profile.',
      heading: 'About your application',
      paragraphs: [
        'Thank you for applying to teach with Serendipity Snow Club, and for the time you put into your profile.',
        "After reviewing it, we're not able to approve your profile right now.",
      ],
      reasonLabel: 'A note from our team:',
      closing:
        "If you have questions or would like to tell us more about your experience, just reply to this email. We're happy to talk.",
      finePrint:
        "You're receiving this because you applied to teach with Serendipity Snow Club.",
    },
    deactivated: {
      subject: 'Your instructor profile is now inactive',
      preheader: 'Your profile is no longer shown on our website.',
      heading: 'Your profile is inactive',
      paragraphs: [
        "We've set your instructor profile to inactive, so it is no longer shown on the Serendipity Snow Club website.",
        "If you think this is a mistake, or you'd like to be reactivated, just reply to this email and we'll sort it out.",
      ],
      finePrint:
        "You're receiving this because you have an instructor profile with Serendipity Snow Club.",
    },
    reactivated: {
      subject: 'Your instructor profile is active again',
      preheader: 'Welcome back to Serendipity Snow Club.',
      heading: 'Welcome back',
      paragraphs: [
        'Good news: your instructor profile has been reactivated.',
        "It's a good moment to sign in and check that your details, certifications and photos are up to date.",
      ],
      button: 'Sign in',
      finePrint:
        "You're receiving this because you have an instructor profile with Serendipity Snow Club.",
    },
    auth: {
      confirmSignup: {
        subject: 'Confirm your email for Serendipity Snow Club',
        preheader: 'One quick step to finish creating your account.',
        heading: 'Confirm your email',
        paragraphs: [
          'Thanks for signing up! Please confirm your email address to finish creating your account. The link is valid for 1 hour.',
        ],
        button: 'Confirm email',
        finePrint:
          "If you didn't create an account, you can safely ignore this email.",
      },
      recovery: {
        subject: 'Reset your Serendipity Snow Club password',
        preheader: 'Choose a new password for your account.',
        heading: 'Reset your password',
        paragraphs: [
          'We received a request to reset the password for your account. Use the button below to choose a new one. The link is valid for 1 hour.',
        ],
        button: 'Reset password',
        finePrint:
          "If you didn't ask to reset your password, you can ignore this email. Your password won't change.",
      },
      magicLink: {
        subject: 'Your Serendipity Snow Club sign-in link',
        preheader: 'Sign in with one click.',
        heading: 'Sign in to Serendipity Snow Club',
        paragraphs: [
          'Use the button below to sign in. The link is valid for 1 hour and works only once.',
        ],
        button: 'Sign in',
        finePrint:
          "If you didn't request this link, you can ignore this email.",
      },
      invite: {
        subject: "You're invited to Serendipity Snow Club",
        preheader: 'Set up your instructor portal account.',
        heading: "You're invited",
        paragraphs: [
          "You've been invited to create an account on the Serendipity Snow Club instructor portal.",
          'Use the button below to accept the invitation and set up your account.',
        ],
        button: 'Accept invitation',
        finePrint:
          "If you weren't expecting this invitation, you can ignore this email.",
      },
      emailChange: {
        subject: 'Confirm your new email address',
        preheader: 'Confirm the change to your account email.',
        heading: 'Confirm your email change',
        paragraphs: [
          'We received a request to change the email address on your Serendipity Snow Club account to {newEmail}.',
          'Use the button below to confirm the change.',
        ],
        button: 'Confirm change',
        finePrint:
          "If you didn't request this change, reply to this email right away and we'll help secure your account.",
      },
      reauthentication: {
        subject: 'Your Serendipity Snow Club verification code',
        preheader: 'Your one-time verification code.',
        heading: "Confirm it's you",
        paragraphs: ["Enter this code to confirm it's you and continue:"],
        finePrint:
          "If you didn't request this code, you can ignore this email. Never share this code with anyone.",
      },
      passwordChanged: {
        subject: 'Your Serendipity Snow Club password was changed',
        preheader: 'A quick security notice about your account.',
        heading: 'Your password was changed',
        paragraphs: [
          'The password for your Serendipity Snow Club account was just changed.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice because your account password changed.",
      },
      emailChanged: {
        subject: 'Your Serendipity Snow Club email address was changed',
        preheader: 'A quick security notice about your account.',
        heading: 'Your email address was changed',
        paragraphs: [
          'The email address for your Serendipity Snow Club account was changed from {oldEmail} to {newEmail}.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice at your previous email address because your account email changed.",
      },
      phoneChanged: {
        subject: 'Your Serendipity Snow Club phone number was changed',
        preheader: 'A quick security notice about your account.',
        heading: 'Your phone number was changed',
        paragraphs: [
          'The phone number on your Serendipity Snow Club account was just changed.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice because your account phone number changed.",
      },
      identityLinked: {
        subject: 'A new sign-in method was added to your account',
        preheader: 'A quick security notice about your account.',
        heading: 'New sign-in method added',
        paragraphs: [
          'A new sign-in method ({provider}) was linked to your Serendipity Snow Club account.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice because the sign-in methods on your account changed.",
      },
      identityUnlinked: {
        subject: 'A sign-in method was removed from your account',
        preheader: 'A quick security notice about your account.',
        heading: 'Sign-in method removed',
        paragraphs: [
          'A sign-in method ({provider}) was removed from your Serendipity Snow Club account.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice because the sign-in methods on your account changed.",
      },
      mfaEnrolled: {
        subject: 'Two-step verification was added to your account',
        preheader: 'A quick security notice about your account.',
        heading: 'Two-step verification added',
        paragraphs: [
          'A new two-step verification method ({factorType}) was added to your Serendipity Snow Club account.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice because the two-step verification settings on your account changed.",
      },
      mfaUnenrolled: {
        subject: 'Two-step verification was removed from your account',
        preheader: 'A quick security notice about your account.',
        heading: 'Two-step verification removed',
        paragraphs: [
          'A two-step verification method ({factorType}) was removed from your Serendipity Snow Club account.',
          "If you made this change, there's nothing else to do. If you didn't, reply to this email right away and we'll help secure your account.",
        ],
        finePrint:
          "You're receiving this security notice because the two-step verification settings on your account changed.",
      },
      generic: {
        subject: 'A message about your Serendipity Snow Club account',
        preheader: 'An update about your account.',
        heading: 'About your account',
        paragraphs: [
          'We received a request related to your Serendipity Snow Club account.',
        ],
        linkParagraph:
          'If it was you, use the button below to continue. The link is valid for 1 hour.',
        button: 'Continue',
        finePrint:
          "If you didn't make this request, you can ignore this email, or reply to it and we'll help secure your account.",
      },
    },
    invite: {
      season: {
        subject:
          'Your {season} Serendipity Snow Club instructor account is ready',
        preheader: 'Activate your account and choose your password.',
        heading: 'Activate your instructor account',
        paragraphs: [
          "We've set up your Serendipity Snow Club instructor account for the {season} season.",
          'Use the button below to activate it and choose your own password. Then take a few minutes to check your profile, certifications and teaching locations.',
        ],
        button: 'Activate my account',
        finePrint:
          'This link is just for you and stays valid for {validDays} days. If it expires, you can ask for a new one on the page it opens.',
      },
      reminder: {
        subject:
          'Reminder: activate your Serendipity Snow Club instructor account',
        preheader: 'Your instructor account is still waiting for you.',
        heading: 'Your account is waiting',
        paragraphs: [
          "A quick reminder: your instructor account for the {season} season is ready, but it hasn't been activated yet.",
          'It only takes a minute. Use the button below and choose your password.',
        ],
        button: 'Activate my account',
        finePrint:
          'This is a fresh link, valid for {validDays} days. If it expires, you can ask for a new one on the page it opens.',
      },
    },
    certification: {
      labels: {
        regular: '{org} Level {level}',
        park: '{org} Park Level {level}',
        carving: '{org} Carving Level {level}',
      },
      expiring: {
        subject: 'Your {certification} certification expires on {validUntil}',
        preheader:
          'Upload your renewed certification to stay cleared to teach.',
        heading: 'Your certification is about to expire',
        paragraphs: [
          'The {certification} proof on your instructor profile is valid until {validUntil}.',
          'Once you have renewed your membership, upload the new proof in the instructor portal so we can keep scheduling you.',
        ],
        button: 'Upload renewed certification',
        finePrint:
          "If you've already uploaded your renewed certification, you can ignore this email.",
      },
      expired: {
        subject: 'Your {certification} certification has expired',
        preheader: 'Upload your renewed certification to keep teaching.',
        heading: 'Your certification has expired',
        paragraphs: [
          'The {certification} proof on your instructor profile was valid until {validUntil} and has now expired.',
          'Please renew your membership and upload the new proof in the instructor portal.',
        ],
        button: 'Upload new certification',
        finePrint:
          "If you've already uploaded your renewed certification, you can ignore this email.",
      },
    },
    admin: {
      instructorPending: {
        subject: 'New instructor waiting for review: {instructorEmail}',
        preheader: 'A new instructor profile needs your review.',
        heading: 'New instructor sign-up',
        paragraphs: [
          '{instructorEmail} just signed in to the instructor portal for the first time, and a new profile is waiting for review.',
        ],
        button: 'Review profile',
        finePrint:
          "You're receiving this because you're an admin of Serendipity Snow Club.",
      },
    },
    documents: {
      assigned: {
        subject: 'Onboarding documents to complete',
        preheader: 'Please read and sign your onboarding documents.',
        heading: 'Your onboarding documents',
        paragraphs: [
          'Please read and complete these documents in the instructor portal:',
          'It only takes a few minutes, and you can do it on your phone.',
        ],
        button: 'Open my documents',
        finePrint:
          "You're receiving this because you're an instructor with Serendipity Snow Club.",
      },
      assignedOnApproval: {
        subject: "You're approved: onboarding documents to complete",
        preheader: 'Your SSnow instructor profile is approved.',
        heading: "You're approved",
        paragraphs: [
          'Your SSnow instructor profile is approved. Before the season starts, please complete:',
          'It only takes a few minutes, and you can do it on your phone.',
        ],
        button: 'Open onboarding',
        finePrint:
          "You're receiving this because you're an instructor with Serendipity Snow Club.",
      },
      reminder: {
        subject: 'Reminder: onboarding documents waiting for you',
        preheader: 'Some onboarding documents are still open.',
        heading: 'Documents still to complete',
        paragraphs: [
          'A quick reminder: these documents are still waiting for you in the instructor portal:',
          'Please complete them before your first lesson.',
        ],
        button: 'Open my documents',
        finePrint:
          "You're receiving this because you're an instructor with Serendipity Snow Club. We send at most one reminder a week.",
      },
      completed: {
        subject: 'Your signed copy: {title}',
        preheader: 'Your signed document is attached.',
        heading: 'Thanks for signing',
        paragraphs: [
          'You signed {title}. Your signed copy is attached to this email as a PDF.',
        ],
        fingerprintLabel: 'SHA-256 of the attached PDF:',
        button: 'Open my documents',
        finePrint:
          'Keep this email for your records. The SHA-256 lets anyone check that the attached file has not been changed since you signed it.',
      },
    },
  },
};

export default en;
