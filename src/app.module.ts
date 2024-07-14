import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { SnapshotModule } from './snapshot/snapshot.module';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuardV2 } from './core/guards/throttle.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
    }),
    ThrottlerModule.forRoot({
      ttl: 3600,
      limit: 180,
    }),
    SnapshotModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuardV2,
    },
  ],
})
export class AppModule {}
