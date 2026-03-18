import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Scope,
} from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import { Browser, Page, PDFOptions } from 'puppeteer';
import JSZip from 'jszip';
import { SnapshotOptionDto } from './../core/interfaces/requestDto';
import { UrlPdfItem } from './snapshot.interface';
/**
 * 常用分辨率
 * https://gs.statcounter.com/screen-resolution-stats/desktop/worldwide
 * https://gs.statcounter.com/screen-resolution-stats/tablet/worldwide
 * https://gs.statcounter.com/screen-resolution-stats/mobile/worldwide
 *
 * 页面截图的选项
 * https://pptr.dev/#?product=Puppeteer&version=v5.3.1&show=api-pagescreenshotoptions
 */

@Injectable({ scope: Scope.REQUEST })
export class SnapshotService {
  private readonly defaultPdfViewport = {
    width: 1440,
    height: 1024,
    deviceScaleFactor: 1,
  } as const;

  // Limit parallel page renders so a single batch does not exhaust Chromium CPU/memory.
  private readonly urlPdfMaxConcurrent = Math.max(
    Number.parseInt(process.env.SNAPSHOT_URL_PDF_CONCURRENCY || '10', 10) || 10,
    1,
  );

  // Batch export uses shorter waits and exits early once scrolling no longer reveals new content.
  private readonly urlPdfLoadOptions: SnapshotOptionDto = {
    scrollTimes: 20,
    minScrollTimes: 4,
    scrollDelay: 400,
    scrollOffset: 2000,
  };

  /**
   * 浏览器实例
   */
  private browser: Browser;

  /**
   * 页面实例
   */
  private page: Page;

  private isRunning = false;

  private readonly logger = new Logger(SnapshotService.name);

  async init(debug = false) {
    if (!this.browser && this.isRunning === false) {
      this.isRunning = true;

      // puppeteer.use(StealthPlugin());

      this.browser = await puppeteer.launch({
        headless: true,
        devtools: debug,
        /**
         * 语言设置
         * https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
         * TODO: --lang设了也没用 可以测试 https://mp.weixin.qq.com/s/-mdhLUQ1EYMGrsOjsgsOzQ
         */
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // https://stackoverflow.com/questions/48297515/puppeteer-chromium-handle-crashing-memory-heavy-pages
          '--disable-dev-shm-usage',
          '--lang=zh',
          // '--single-process',
          '--no-zygote',
          // 字体加载问题 https://github.com/Zijue/blog/issues/44
          '--font-render-hinting=none',
        ],
        defaultViewport: null,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        // executablePath: path.join(__dirname, './../../chrome-linux/chrome'),
        // executablePath: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      });
      this.logger.debug(`init - new browser`);
    }
  }

  async toPDF(content: string, pdfOption?: PDFOptions): Promise<Buffer> {
    try {
      await this.init();

      this.page = (await this.browser.pages())[0];

      await this.page.setContent(content);

      // 配置PDF选项
      const pdfBuffer = await this.page.pdf({
        format: 'A4',
        printBackground: true,
        ...pdfOption,
      });

      return Buffer.from(pdfBuffer);
    } catch (e) {
      throw new HttpException(
        '系统错误：未能生成PDF',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } finally {
      if (this.browser?.connected) {
        const pages = await this.browser.pages();
        for (const page of pages) {
          await page.close();
          this.logger.debug(`toPDF - close page`);
        }
        await this.browser.close();
        this.logger.debug(`toPDF - close browser`);
      }
    }
  }
  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async URL2PDF(url: string, pdfOption?: PDFOptions): Promise<Buffer> {
    try {
      await this.init();

      this.page = (await this.browser.pages())[0];

      await this.page.goto(url, {
        timeout: 100000,
        /**
         * "load"|"domcontentloaded"|"networkidle0"|"networkidle2"
         */
        waitUntil: ['networkidle0'],
      });

      await this.waitPageLoaded(this.page, {
        scrollTimes: 20,
        scrollDelay: 1000,
        scrollOffset: 1000,
      });

      // 配置PDF选项
      const pdfBuffer = await this.page.pdf({
        format: 'A4',
        // printBackground: true,
        ...pdfOption,
      });

      return Buffer.from(pdfBuffer);
    } catch (e) {
      console.log(e);
      throw new HttpException(
        '系统错误：未能生成PDF',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } finally {
      if (this.browser?.connected) {
        const pages = await this.browser.pages();
        for (const page of pages) {
          await page.close();
          this.logger.debug(`toPDF - close page`);
        }
        await this.browser.close();
        this.logger.debug(`toPDF - close browser`);
      }
    }
  }

  async sliceTasks<T>(tasks: (() => Promise<T>)[], maxConcurrent = 10) {
    const results: T[] = [];
    const taskQueue = [...tasks];

    // Execute in bounded batches to avoid opening too many pages at once.
    while (taskQueue.length > 0) {
      const currentTasks = taskQueue.splice(0, maxConcurrent);
      const batchResults = await Promise.all(
        currentTasks.map((task) =>
          task().catch((e) => {
            this.logger.error('PDF生成任务失败:', e);
            throw e;
          }),
        ),
      );
      results.push(...batchResults);

      // 3. 可选：添加批次间的延迟，避免资源竞争
      if (taskQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return results;
  }
  async urlToPdf(
    config: {
      url: string;
      name: string;
      option: PDFOptions;
    }[],
    zipName?: string,
  ): Promise<UrlPdfItem> {
    try {
      if (config.length === 0) {
        throw new HttpException(
          '参数错误：请提供至少一个URL',
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.init();
      const tasks = config.map((item, index) => {
        return () => this.renderUrlPdfItem(item, index);
      });
      const res = await this.sliceTasks(tasks, this.urlPdfMaxConcurrent);

      // console.log('处理完成所有', res);
      if (!res.length) {
        throw new HttpException(
          '系统错误：未能生成PDF',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      } else if (zipName) {
        const zipBuffer = await this.createZipBuffer(res);
        return {
          name: (zipName || Date.now()) + '.zip',
          buffer: zipBuffer,
          headers: {
            'Content-Type': 'application/zip',
          },
        };
      } else if (res.length === 1) {
        return res[0];
      } else {
        const zipBuffer = await this.createZipBuffer(res);
        return {
          name: (zipName || Date.now()) + '.zip',
          buffer: zipBuffer,
          headers: {
            'Content-Type': 'application/zip',
          },
        };
      }
    } catch (e) {
      this.logger.error('urlToPdf - failed', e);
      throw new HttpException(e, HttpStatus.INTERNAL_SERVER_ERROR);
    } finally {
      if (this.browser?.connected) {
        await this.browser.close();
        this.logger.debug(`close browser`);
      }
    }
  }

  private async renderUrlPdfItem(
    item: {
      url: string;
      name: string;
      option: PDFOptions;
    },
    index: number,
  ): Promise<UrlPdfItem> {
    const page = await this.browser.newPage();

    try {
      await this.initPage(page);
      await this.initPdfViewport(page);
      // Only wait for the initial document load here; deeper stabilization is handled below.
      await page.goto(item.url, {
        timeout: 60 * 1000,
        waitUntil: ['load'],
      });

      await this.waitPageLoaded(page, this.urlPdfLoadOptions);

      let { width: bodyWidth, height: bodyHeight } =
        await this.getPageDimensions(page);

      if (bodyWidth > this.getViewportWidth(page)) {
        await this.expandPdfViewport(page, bodyWidth);
        await this.waitPageLoaded(page, this.urlPdfLoadOptions);
        ({ width: bodyWidth, height: bodyHeight } =
          await this.getPageDimensions(page));
      }

      const pdfConfig: PDFOptions = {
        printBackground: true,
        preferCSSPageSize: false,
        ...item.option,
      };

      if (!pdfConfig.format) {
        if (pdfConfig.width === undefined) {
          pdfConfig.width = `${bodyWidth}px`;
        }
        if (pdfConfig.height === undefined) {
          pdfConfig.height = `${bodyHeight}px`;
        }
      }

      const pdfBuffer = await page.pdf(pdfConfig);

      return {
        name: `${index + 1}.${item.name}.pdf`,
        buffer: Buffer.from(pdfBuffer),
        headers: {
          'Content-Type': 'application/pdf',
        },
      };
    } finally {
      if (!page.isClosed()) {
        await page.close();
      }
    }
  }
  private async createZipBuffer(
    results: { name: string; buffer: Buffer }[],
  ): Promise<Buffer> {
    const zip = new JSZip();

    // 添加所有PDF文件到ZIP
    results.forEach((t) => {
      zip.file(t.name, new Uint8Array(t.buffer));
    });

    // 生成ZIP buffer
    return await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6,
      },
    });
  }

  private async initPage(page) {
    await page.evaluateOnNewDocument(() => {
      // 禁用所有可能阻止关闭的API
      const disableUnload = () => {
        // 覆盖事件监听
        const originalAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (
          type,
          listener,
          options,
        ) {
          if (
            type === 'beforeunload' ||
            type === 'unload' ||
            type === 'pagehide' ||
            type === 'visibilitychange'
          ) {
            console.warn('阻止添加页面关闭事件:', type);
            return;
          }
          return originalAdd.call(this, type, listener, options);
        };

        // 覆盖on事件属性
        ['beforeunload', 'unload', 'pagehide'].forEach((eventType) => {
          Object.defineProperty(window, `on${eventType}`, {
            get: () => undefined,
            set: () => {},
            configurable: true,
          });

          Object.defineProperty(document, `on${eventType}`, {
            get: () => undefined,
            set: () => {},
            configurable: true,
          });
        });

        // 劫持confirm/alert/prompt
        window.alert = () => {};
        window.confirm = () => true;
        window.prompt = () => null;

        // 阻止默认的beforeunload行为
        window.addEventListener(
          'beforeunload',
          (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.returnValue = '';
            return null;
          },
          { capture: true },
        );
      };

      // 立即执行
      disableUnload();

      // 监听DOMContentLoaded，确保覆盖所有后续添加的事件
      document.addEventListener('DOMContentLoaded', disableUnload, {
        once: true,
      });

      // 监听load事件，做最后的清理
      window.addEventListener(
        'load',
        () => {
          setTimeout(disableUnload, 100);
        },
        { once: true },
      );
    });
  }

  private async initPdfViewport(page: Page): Promise<void> {
    await page.setViewport({ ...this.defaultPdfViewport });
  }

  private getViewportWidth(page: Page): number {
    return page.viewport()?.width || this.defaultPdfViewport.width;
  }

  private async expandPdfViewport(page: Page, width: number): Promise<void> {
    const viewport = page.viewport() || this.defaultPdfViewport;

    await page.setViewport({
      ...viewport,
      width: Math.ceil(width),
    });
    await this.sleep(200);
  }

  private async getPageDimensions(
    page: Page,
  ): Promise<{ width: number; height: number }> {
    return await page.evaluate(() => {
      const body = document.body;
      const documentElement = document.documentElement;

      return {
        width: Math.max(
          body?.clientWidth || 0,
          body?.offsetWidth || 0,
          body?.scrollWidth || 0,
          documentElement?.clientWidth || 0,
          documentElement?.offsetWidth || 0,
          documentElement?.scrollWidth || 0,
        ),
        height: Math.max(
          body?.clientHeight || 0,
          body?.offsetHeight || 0,
          body?.scrollHeight || 0,
          documentElement?.clientHeight || 0,
          documentElement?.offsetHeight || 0,
          documentElement?.scrollHeight || 0,
        ),
      };
    });
  }

  private async getPageScrollState(
    page: Page,
  ): Promise<{ height: number; scrollTop: number; viewportHeight: number }> {
    return await page.evaluate(() => {
      const body = document.body;
      const documentElement = document.documentElement;

      return {
        height: Math.max(
          body?.clientHeight || 0,
          body?.offsetHeight || 0,
          body?.scrollHeight || 0,
          documentElement?.clientHeight || 0,
          documentElement?.offsetHeight || 0,
          documentElement?.scrollHeight || 0,
        ),
        scrollTop:
          window.scrollY ||
          window.pageYOffset ||
          documentElement?.scrollTop ||
          body?.scrollTop ||
          0,
        viewportHeight:
          window.innerHeight || documentElement?.clientHeight || 0,
      };
    });
  }

  // private async waitPageLoaded(page: Page, options?: SnapshotOptionDto) {
  //   const scrollDelay = options?.scrollDelay || 1000;
  //   const maxScrollTimes = options?.scrollTimes || 20;

  //   // 滚动加载
  //   for (let i = 0; i < maxScrollTimes; i++) {
  //     await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  //     await page.waitForTimeout(scrollDelay);
  //   }

  //   // 等待网络空闲
  //   await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });
  // }

  private async waitPageLoaded(page: Page, options?: SnapshotOptionDto) {
    const maxScrollTimes = options?.scrollTimes || 20;
    const minStableScrollRounds = Math.max(options?.minScrollTimes || 5, 1);
    const scrollDelay = options?.scrollDelay || 1000;
    const scrollOffset = parseInt(options?.scrollOffset?.toString()) || 1000;
    let scrollCount = 0;
    let stableScrollRounds = 0;
    let previousState = await this.getPageScrollState(page);

    while (scrollCount < maxScrollTimes) {
      // 执行滚动
      await page.evaluate((offset) => {
        window.scrollBy(0, offset);
      }, scrollOffset);

      await this.sleep(scrollDelay);

      const currentState = await this.getPageScrollState(page);
      const heightStable = currentState.height === previousState.height;
      const reachedBottom =
        currentState.scrollTop + currentState.viewportHeight >=
        currentState.height - 2;
      const scrollStuck = currentState.scrollTop === previousState.scrollTop;

      // Stop once scrolling no longer increases height and the viewport is already at the end.
      if (heightStable && (reachedBottom || scrollStuck)) {
        stableScrollRounds += 1;
      } else {
        stableScrollRounds = 0;
      }

      previousState = currentState;
      scrollCount += 1;

      if (stableScrollRounds >= minStableScrollRounds) {
        break;
      }
    }

    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    try {
      await page.waitForNetworkIdle({
        idleTime: scrollDelay,
        timeout: Math.max(scrollDelay * 4, 1500),
      });
    } catch (e) {
      this.logger.warn('waitPageLoaded - network idle timeout');
    }
  }
}
