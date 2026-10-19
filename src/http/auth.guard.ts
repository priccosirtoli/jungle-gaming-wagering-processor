import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * Extension point for provider authentication. Intentionally a no-op: auth is
 * out of scope for the challenge. The intended design (an external IdP such as
 * Keycloak issuing client-credentials tokens per provider, with the token's
 * provider id checked against `providerId` in the payload) is described in
 * ARCHITECTURE.md. Health endpoints never use this guard.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
