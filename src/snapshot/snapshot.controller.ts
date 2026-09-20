import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { Request, Response } from 'express';
import { PDFOptions } from 'puppeteer';

@Controller('snapshot')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  private readonly logger = new Logger(SnapshotController.name);

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
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // 客户端关闭页面/取消请求时主动中断本批次渲染，避免无人接收结果还继续烧 CPU。
    // 这些事件在正常完成时也会触发，统一用“响应尚未结束”判断。
    const abortController = new AbortController();

    const abortRender = (source: string) => {
      if (abortController.signal.aborted || res.writableEnded) {
        return;
      }
      // 打出触发来源，便于区分“浏览器断开”“代理断开”还是“根本没收到断开事件”。
      this.logger.warn(`[url/pdf] 客户端连接已断开: source=${source}`);
      abortController.abort();
    };

    const requestSocket = req?.socket;
    const onSocketClose = () => abortRender('socket-close');
    const onRequestAborted = () => abortRender('request-aborted');
    const onResponseClose = () => {
      abortRender('response-close');
      // 连接可能被 keep-alive 复用，及时摘掉监听，避免监听器堆积。
      requestSocket?.off('close', onSocketClose);
      (req as any)?.off?.('aborted', onRequestAborted);
    };

    res.on('close', onResponseClose);
    // 有些代理/运行时不触发 res close，只断开底层 socket，因此同时监听多个来源。
    requestSocket?.on('close', onSocketClose);
    (req as any)?.on?.('aborted', onRequestAborted);
    // 监听注册之前客户端就可能已经断开。
    if (res.destroyed || (req as any)?.aborted) {
      abortRender('already-closed');
    }

    try {
      const { name, buffer, headers } = await this.snapshotService.urlToPdf(
        config,
        zipName,
        abortController.signal,
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
      // 客户端已断开：连接已经没了，不再写回任何响应。
      if (abortController.signal.aborted) {
        return;
      }
      res.status(200).send(e);
    }
  }
}
