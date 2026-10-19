import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import { BusinessRuleError, InvalidInputError, InvalidTransactionStateError } from '../domain/shared/errors.js';
import {
  ApplicationError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../application/errors.js';

export interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * One mapping for every endpoint, so a provider can decide on the status code
 * alone whether to resend:
 *   400 INVALID_PAYLOAD        fix the request, do not resend as-is
 *   404 *_NOT_FOUND            unknown wallet or transaction
 *   409 IDEMPOTENCY_CONFLICT   key reused with another payload, never a replay
 *   409 WALLET_ALREADY_EXISTS
 *   422 <failureCode>          business rejection (wagering responses carry it in the body)
 *   503 TRANSIENT_FAILURE      infrastructure hiccup, safe to retry with the same key
 *   500 INTERNAL_ERROR         bug; logged
 */
export function mapError(error: unknown): { status: number; body: ErrorBody; retryable: boolean } {
  const body = (code: string, message: string): ErrorBody => ({ error: { code, message } });
  if (error instanceof ValidationError || error instanceof InvalidInputError) {
    return { status: HttpStatus.BAD_REQUEST, body: body('INVALID_PAYLOAD', error.message), retryable: false };
  }
  if (error instanceof NotFoundError) {
    return { status: HttpStatus.NOT_FOUND, body: body(error.code, error.message), retryable: false };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: HttpStatus.CONFLICT, body: body(error.code, error.message), retryable: false };
  }
  if (error instanceof BusinessRuleError) {
    return { status: HttpStatus.UNPROCESSABLE_ENTITY, body: body(error.failureCode, error.message), retryable: false };
  }
  if (error instanceof ApplicationError) {
    return { status: HttpStatus.UNPROCESSABLE_ENTITY, body: body(error.code, error.message), retryable: false };
  }
  if (isTransient(error)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: body('TRANSIENT_FAILURE', 'Temporary infrastructure failure, retry with the same Idempotency-Key'),
      retryable: true,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === HttpStatus.BAD_REQUEST ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
    return { status, body: body(code, error.message), retryable: false };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: body('INTERNAL_ERROR', 'Unexpected error'), retryable: false };
}

/** Errors worth retrying: lost connection, lock wait timeout, deadlock, serialization failure. */
export function isTransient(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof LockWaitTimeoutException ||
    error instanceof DeadlockException
  ) {
    return true;
  }
  if (error instanceof DriverException) {
    const code = (error as DriverException & { code?: string }).code ?? '';
    // 40001 serialization_failure, 55P03 lock_not_available, 57P01 admin_shutdown, 08* connection
    return ['40001', '55P03', '57P01', '57P02', '57P03'].includes(code) || code.startsWith('08');
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code);
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, retryable } = mapError(error);
    if (status >= 500 || error instanceof InvalidTransactionStateError) {
      this.logger.error({ message: 'Request failed', code: body.error.code, error: String(error) });
    }
    if (retryable) {
      res.setHeader('Retry-After', '1');
    }
    res.status(status).json(body);
  }
}
