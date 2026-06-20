import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Protects non-public routes (T1.3). Missing/malformed/expired JWT → 401.
 * Usage: `@UseGuards(SupabaseAuthGuard)`.
 */
@Injectable()
export class SupabaseAuthGuard extends AuthGuard('supabase-jwt') {}
