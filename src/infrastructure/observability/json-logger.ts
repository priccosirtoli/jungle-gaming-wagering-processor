import type { LoggerService } from '@nestjs/common';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

/**
 * One JSON object per line. Object messages are spread at the top level, so
 * fields such as correlationId, messageId, transactionId, walletId and
 * providerId are directly queryable. Callers log identifiers and codes, never
 * full payloads.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    // Nest passes the context last; error() may also pass a stack trace before it.
    const context = typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    const stack = level === 'error' && typeof params[0] === 'string' ? params[0] : undefined;
    const fields =
      typeof message === 'object' && message !== null && !(message instanceof Error)
        ? (message as Record<string, unknown>)
        : { message: message instanceof Error ? message.message : String(message) };
    const line = {
      level,
      time: new Date().toISOString(),
      pid: process.pid,
      ...(context ? { context } : {}),
      ...fields,
      ...(stack ? { stack } : {}),
    };
    const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }
}
