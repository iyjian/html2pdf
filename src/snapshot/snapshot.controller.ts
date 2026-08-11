import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
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
      const result = await this.snapshotService.URL2PDF(url, pdfOption);
      res.set('Content-Type', 'application/x-pdf');
      res.set('Content-Disposition', `attachment;filename=${fileName}`);
      res.send(result);
      return true;
    } catch (e) {
      const status =
        e instanceof HttpException
          ? e.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
      const response =
        e instanceof HttpException ? e.getResponse() : '系统错误：未能生成PDF';
      const errMsg =
        typeof response === 'string'
          ? response
          : Array.isArray(response['message'])
          ? response['message'].join(', ')
          : String(response['message'] || 'internal error');

      res.status(status).json({ err: status, errMsg });
    }
  }

  @Post('/url/pdf')
  async urlToPaf(
    @Body('config')
    config: {
      url: string;
      name: string;
      option: PDFOptions;
    }[],
    @Body('zipName') zipName = 'download',
    @Res() res: Response,
  ) {
    try {
      const { name, buffer, headers } = await this.snapshotService.urlToPdf(
        config,
        zipName,
      );
      for (const key in headers) {
        res.set(key, headers[key]);
      }
      res.set('Access-Control-Expose-Headers', 'Content-Disposition');
      res.set(
        'Content-Disposition',
        `attachment;filename=${encodeURIComponent(name)}`,
      );
      res.send(buffer);
    } catch (e) {
      res.status(200).send(e);
    }
  }
}
