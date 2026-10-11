import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  DEFAULT_GOOGLE_OAUTH_RETURN_URL,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleConfig,
} from './google.config';
import { GoogleAuthError } from './google.errors';
import type {
  AdminGoogleCalendar,
  FreeBusyResult,
  GoogleConnectionStatus,
} from './google.types';
import { GoogleCalendarClient } from './google-calendar.client';
import { GoogleConnectionRepository } from './google-connection.repository';
import {
  type GoogleCodeGrant,
  GoogleOAuthClient,
  type GoogleUserInfo,
} from './google-oauth.client';
import {
  defaultGoogleRuntime,
  GOOGLE_RUNTIME,
  type GoogleRuntime,
} from './google-runtime';
import { signOAuthState, verifyOAuthState } from './oauth-state';
import { decryptToken, encryptToken } from './token-cipher';

export const MAX_FREEBUSY_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
export const WRITABLE_ACCESS_ROLES = new Set(['writer', 'owner']);

export const GOOGLE_CALLBACK_ERRORS = {
  notConfigured: 'not_configured',
  invalidState: 'invalid_state',
  accessDenied: 'access_denied',
  oauthError: 'oauth_error',
  missingCode: 'missing_code',
  tokenExchangeFailed: 'token_exchange_failed',
  wrongAccount: 'wrong_account',
  missingScopes: 'missing_scopes',
  noRefreshToken: 'no_refresh_token',
  serverError: 'server_error',
} as const;

export type GoogleCallbackError =
  (typeof GOOGLE_CALLBACK_ERRORS)[keyof typeof GOOGLE_CALLBACK_ERRORS];

export interface OAuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
}

@Injectable()
export class GoogleConnectionService {
  private readonly logger = new Logger(GoogleConnectionService.name);
  private readonly runtime: GoogleRuntime;

  constructor(
    private readonly configService: ConfigService,
    private readonly oauth: GoogleOAuthClient,
    private readonly connections: GoogleConnectionRepository,
    private readonly calendar: GoogleCalendarClient,
    private readonly audit: AuditService,
    @Optional()
    @Inject(GOOGLE_RUNTIME)
    runtime?: Partial<GoogleRuntime>,
  ) {
    this.runtime = { ...defaultGoogleRuntime, ...runtime };
  }

  connectUrl(userId: string): { url: string } {
    const config = this.oauth.config();
    const state = signOAuthState(
      userId,
      config.clientSecret,
      this.runtime.now(),
    );
    return { url: this.oauth.authorizeUrl(state) };
  }

  async handleCallback(params: OAuthCallbackParams): Promise<string> {
    if (!this.oauth.isConfigured()) {
      return this.portalUrl({ error: GOOGLE_CALLBACK_ERRORS.notConfigured });
    }
    const config = this.oauth.config();
    const state = verifyOAuthState(
      params.state,
      config.clientSecret,
      this.runtime.now(),
    );
    if (!state) {
      return this.portalUrl({ error: GOOGLE_CALLBACK_ERRORS.invalidState });
    }
    if (params.error) {
      return this.portalUrl({
        error:
          params.error === 'access_denied'
            ? GOOGLE_CALLBACK_ERRORS.accessDenied
            : GOOGLE_CALLBACK_ERRORS.oauthError,
      });
    }
    if (!params.code) {
      return this.portalUrl({ error: GOOGLE_CALLBACK_ERRORS.missingCode });
    }
    const actor: AuditActor = { userId: state.userId, role: 'admin' };

    let grant: GoogleCodeGrant;
    try {
      grant = await this.oauth.exchangeCode(params.code);
    } catch (err) {
      const code = err instanceof GoogleAuthError ? err.code : 'unknown';
      this.logger.warn(`Google code exchange failed: ${code}`);
      return this.portalUrl({
        error: GOOGLE_CALLBACK_ERRORS.tokenExchangeFailed,
      });
    }

    let userInfo: GoogleUserInfo;
    try {
      userInfo = await this.oauth.userInfo(grant.accessToken);
    } catch (err) {
      const code = err instanceof GoogleAuthError ? err.code : 'unknown';
      this.logger.warn(`Google userinfo lookup failed: ${code}`);
      await this.oauth.revoke(grant.refreshToken ?? grant.accessToken);
      return this.portalUrl({
        error: GOOGLE_CALLBACK_ERRORS.tokenExchangeFailed,
      });
    }

    const rejection = rejectionFor(grant, userInfo, config);
    if (rejection) {
      await this.oauth.revoke(grant.refreshToken ?? grant.accessToken);
      await this.audit.record({
        action: AUDIT_ACTIONS.googleConnectRejected,
        actor,
        targetType: 'google_connection',
        metadata: {
          reason: rejection,
          accountEmail: userInfo.email,
          scopes: grant.scopes,
        },
      });
      return this.portalUrl({ error: rejection });
    }

    try {
      await this.connections.save({
        accountEmail: userInfo.email as string,
        refreshTokenEnc: encryptToken(
          grant.refreshToken as string,
          config.encKey,
        ),
        scopes: grant.scopes,
        connectedBy: state.userId,
        connectedAt: new Date(this.runtime.now()).toISOString(),
      });
    } catch (err) {
      this.logger.error(
        `Failed to store Google connection: ${(err as Error).message}`,
      );
      await this.oauth.revoke(grant.refreshToken as string);
      return this.portalUrl({ error: GOOGLE_CALLBACK_ERRORS.serverError });
    }
    this.calendar.invalidate();
    await this.audit.record({
      action: AUDIT_ACTIONS.googleConnect,
      actor,
      targetType: 'google_connection',
      metadata: { accountEmail: userInfo.email, scopes: grant.scopes },
    });
    return this.portalUrl({ connected: '1' });
  }

  async status(): Promise<GoogleConnectionStatus> {
    const configured = this.oauth.isConfigured();
    const row = await this.connections.get();
    return {
      configured,
      connected: configured && Boolean(row?.refresh_token_enc),
      accountEmail: row?.account_email ?? null,
      scopes: row?.scopes ?? [],
      connectedAt: row?.connected_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  async disconnect(actor: AuditActor): Promise<GoogleConnectionStatus> {
    const row = await this.connections.get();
    if (row) {
      let revoked = false;
      if (row.refresh_token_enc && this.oauth.isConfigured()) {
        try {
          revoked = await this.oauth.revoke(
            decryptToken(row.refresh_token_enc, this.oauth.config().encKey),
          );
        } catch {
          revoked = false;
        }
      }
      await this.connections.delete();
      await this.audit.record({
        action: AUDIT_ACTIONS.googleDisconnect,
        actor,
        targetType: 'google_connection',
        metadata: { accountEmail: row.account_email, revoked },
      });
    }
    this.calendar.invalidate();
    return this.status();
  }

  async calendars(): Promise<AdminGoogleCalendar[]> {
    const calendars = await this.calendar.listCalendars();
    return calendars.map((calendar) => ({
      ...calendar,
      canWrite: WRITABLE_ACCESS_ROLES.has(calendar.accessRole),
    }));
  }

  freeBusy(
    calendarIds: string[],
    from: string,
    to: string,
  ): Promise<FreeBusyResult> {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!(end > start)) {
      throw new BadRequestException('`to` must be after `from`');
    }
    if (end - start > MAX_FREEBUSY_RANGE_MS) {
      throw new BadRequestException('The range must be 31 days or less');
    }
    return this.calendar.freeBusy(
      calendarIds,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
    );
  }

  private portalUrl(
    params: { error: GoogleCallbackError } | { connected: '1' },
  ): string {
    const base =
      this.configService.get<string>('GOOGLE_OAUTH_RETURN_URL')?.trim() ||
      DEFAULT_GOOGLE_OAUTH_RETURN_URL;
    return `${base}?${new URLSearchParams(params).toString()}`;
  }
}

function rejectionFor(
  grant: GoogleCodeGrant,
  userInfo: GoogleUserInfo,
  config: GoogleConfig,
): GoogleCallbackError | null {
  if (!userInfo.emailVerified || userInfo.email !== config.allowedAccount) {
    return GOOGLE_CALLBACK_ERRORS.wrongAccount;
  }
  if (!GOOGLE_CALENDAR_SCOPES.every((scope) => grant.scopes.includes(scope))) {
    return GOOGLE_CALLBACK_ERRORS.missingScopes;
  }
  if (!grant.refreshToken) {
    return GOOGLE_CALLBACK_ERRORS.noRefreshToken;
  }
  return null;
}
