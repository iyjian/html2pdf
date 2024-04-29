import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';

export class ThrottlerGuardV2 extends ThrottlerGuard {
  protected throwThrottlingException(): void {
    throw new ThrottlerException('你本小时的请求次数已经用完(每小时10次)');
  }
}
