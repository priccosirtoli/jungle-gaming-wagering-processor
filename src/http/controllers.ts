import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { isUuid, parseCreateWallet, parseSubmitWager } from '../application/commands.js';
import { NotFoundError } from '../application/errors.js';
import { newId } from '../application/ids.js';
import { ProcessWagerService } from '../application/process-wager.service.js';
import { WalletService } from '../application/wallet.service.js';
import { ProviderAuthGuard } from './auth.guard.js';
import {
  ledgerEntryView,
  reconciliationView,
  transactionView,
  wagerHttpStatus,
  wagerResponse,
  walletView,
} from './presenters.js';

const correlationIdFrom = (header: string | undefined) => (header && header.length <= 200 ? header : newId());

function walletIdParam(walletId: string): string {
  if (!isUuid(walletId)) {
    throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
  }
  return walletId.toLowerCase();
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlationId?: string) {
    const wallet = await this.wallets.create(parseCreateWallet(body), correlationIdFrom(correlationId));
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.wallets.get(walletIdParam(walletId)));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const page = await this.wallets.ledger(walletIdParam(walletId), cursor || undefined, Number(limit ?? 50));
    return { entries: page.entries.map(ledgerEntryView), nextCursor: page.nextCursor ?? null };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    return reconciliationView(await this.wallets.reconcile(walletIdParam(walletId)));
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerService) private readonly processWager: ProcessWagerService,
    @Inject(WalletService) private readonly wallets: WalletService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseSubmitWager(body, idempotencyKey);
    const result = await this.processWager.execute(command, { correlationId: correlationIdFrom(correlationId) });
    res.status(wagerHttpStatus(result.transaction.status));
    return wagerResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    if (!isUuid(transactionId)) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    }
    const tx = await this.wallets.transactionById(transactionId.toLowerCase());
    return transactionView(tx, await this.wallets.balanceFor(tx));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.wallets.transactionByExternalId(providerId, externalTransactionId);
    return transactionView(tx, await this.wallets.balanceFor(tx));
  }
}
