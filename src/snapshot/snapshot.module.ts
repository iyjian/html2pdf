import { Module } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { SnapshotController } from './snapshot.controller';

@Module({
  providers: [SnapshotService],
  controllers: [SnapshotController],
})
export class SnapshotModule {}
