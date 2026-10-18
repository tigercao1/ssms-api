/** One `instructor_invites` row. `token_hash` is null until the invite is first sent. */
export interface InviteRow {
  id: string;
  instructor_id: string;
  auth_user_id: string;
  email: string;
  token_hash: string | null;
  season: string;
  expires_at: string | null;
  send_claimed_at: string | null;
  sent_at: string | null;
  remind_claimed_at: string | null;
  reminded_at: string | null;
  redeemed_at: string | null;
  activated_at: string | null;
  created_at: string;
}

/** An invite plus the instructor fields its email needs. */
export interface InviteRecipient extends InviteRow {
  display_name_en: string;
  preferred_language: string | null;
}

/** `POST /activation/redeem` response. */
export interface RedeemedInvite {
  email: string;
  tokenHash: string;
}

/** `POST /activation/resend` response, the same shape for every email. */
export interface ResendAccepted {
  status: 'accepted';
  retryAfterSeconds: number;
}

/** Fields the roster import sets on a new invite row. */
export interface NewInvite {
  instructor_id: string;
  auth_user_id: string;
  email: string;
  season: string;
}
