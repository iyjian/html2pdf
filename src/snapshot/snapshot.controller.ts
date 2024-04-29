import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { Response } from 'express';

@Controller('snapshot')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  @Post('/toPDF')
  async toPDF(@Body('content') content: string, @Res() res: Response) {
    res.set('Content-Type', 'application/x-pdf');
    res.set('Content-Disposition', `attachment;filename=test.pdf`);
    const result = await this.snapshotService.toPDF(content);
    res.send(result);
    return true;
  }
}
