import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleConfig,
  readGoogleConfig,
} from './google.config';
import { GoogleAuthError } from './google.errors';
import {
  errorMessage,
  errorReason,
  readErrorBody,
  sendWithRetry,
} from './google-http';
import {
  defaultGoogleRuntime,
  GOOGLE_RUNTIME,
  type GoogleRuntime,
} from './google-runtime';

export const GOOGLE_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL =
  'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleAccessGrant {
  accessToken: string;
  expiresInSeconds: number;
}

export interface GoogleCodeGrant extends GoogleAccessGrant {
  refreshToken: string | null;
  scopes: string[];
}

export interface GoogleUserInfo {
  email: string | null;
  emailVerified: boolean;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface UserInfoResponse {
  email?: unknown;
  email_verified?: unknown;
}

@Injectable()
export class GoogleOAuthClient {
  private readonly runtime: GoogleRuntime;
  private settings?: GoogleConfig;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(GOOGLE_RUNTIME)
    runtime?: Partial<GoogleRuntime>,
  ) {
    this.runtime = { ...defaultGoogleRuntime, ...runtime };
  }

  isConfigured(): boolean {
    try {
      this.config();
      return true;
    } catch {
      return false;
    }
  }

  config(): GoogleConfig {
    this.settings ??= readGoogleConfig((key) =>
      this.configService.get<string>(key),
    );
    return this.settings;
  }

  authorizeUrl(state: string): string {
    const config = this.config();
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: [...GOOGLE_IDENTITY_SCOPES, ...GOOGLE_CALENDAR_SCOPES].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      hd: config.hostedDomain,
      login_hint: config.allowedAccount,
      state,
    });
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<GoogleCodeGrant> {
    const config = this.config();
    const body = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    });
    return {
      accessToken: body.access_token as string,
      expiresInSeconds: body.expires_in ?? 0,
      refreshToken: body.refresh_token ?? null,
      scopes: (body.scope ?? '').split(' ').filter((s) => s !== ''),
    };
  }

  async userInfo(accessToken: string): Promise<GoogleUserInfo> {
    let response: Response;
    try {
      ({ response } = await sendWithRetry(
        this.runtime,
        GOOGLE_USERINFO_URL,
        () => ({
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        }),
      ));
    } catch (err) {
      throw new GoogleAuthError(
        undefined,
        'network_error',
        (err as Error).message,
      );
    }
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new GoogleAuthError(
        response.status,
        errorReason(body) ?? 'http_error',
        errorMessage(body),
      );
    }
    const body = (await response.json()) as UserInfoResponse;
    return {
      email: typeof body.email === 'string' ? body.email.toLowerCase() : null,
      emailVerified: body.email_verified === true,
    };
  }

  async refresh(refreshToken: string): Promise<GoogleAccessGrant> {
    const config = this.config();
    const body = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    return {
      accessToken: body.access_token as string,
      expiresInSeconds: body.expires_in ?? 0,
    };
  }

  async revoke(token: string): Promise<boolean> {
    try {
      const { response } = await sendWithRetry(
        this.runtime,
        GOOGLE_REVOKE_URL,
        () => ({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        }),
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<TokenResponse> {
    let response: Response;
    try {
      ({ response } = await sendWithRetry(
        this.runtime,
        GOOGLE_TOKEN_URL,
        () => ({
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams(form).toString(),
        }),
      ));
    } catch (err) {
      throw new GoogleAuthError(
        undefined,
        'network_error',
        (err as Error).message,
      );
    }
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new GoogleAuthError(
        response.status,
        errorReason(body) ?? 'http_error',
        errorMessage(body),
      );
    }
    const body = (await response.json()) as TokenResponse;
    if (!body.access_token) {
      throw new GoogleAuthError(response.status, 'no_access_token', '');
    }
    return body;
  }
}
