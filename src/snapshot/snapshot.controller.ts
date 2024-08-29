import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { Response } from 'express';
import { PDFOptions } from 'puppeteer';

@Controller('snapshot')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  @Post('/toPDF')
  async toPDF(
    @Body('content') content: string,
    @Body('fileName') fileName: string = 'download.pdf',
    @Body('pdfOption') pdfOption: PDFOptions,
    @Res() res: Response,
  ) {
    res.set('Content-Type', 'application/x-pdf');
    res.set('Content-Disposition', `attachment;filename=${fileName}`);
    const result = await this.snapshotService.toPDF(content, pdfOption);
    res.send(result);
    return true;
  }

  @Post('/URL2PDF')
  async URL2PDF(
    @Body('url') url: string,
    @Body('fileName') fileName: string = 'download.pdf',
    @Body('pdfOption') pdfOption: PDFOptions,
    @Res() res: Response,
  ) {
    try {
      res.set('Content-Type', 'application/x-pdf');
      res.set('Content-Disposition', `attachment;filename=${fileName}`);
      const result = await this.snapshotService.URL2PDF(url, pdfOption);
      res.send(result);
      return true;
    } catch (e) {
      console.log(e);
      return true;
    }
  }
}
