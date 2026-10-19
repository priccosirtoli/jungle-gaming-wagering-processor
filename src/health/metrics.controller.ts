import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Metrics } from '../infrastructure/observability/metrics.js';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  render(): string {
    return this.metrics.render();
  }
}
