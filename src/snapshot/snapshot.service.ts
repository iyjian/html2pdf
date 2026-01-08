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
          '--single-process',
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

  async sliceTasks(tasks: (() => Promise<void>)[], maxConcurrent = 10) {
    const results: any[] = [];
    const taskQueue = [...tasks];

    // 2. 分批执行
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
      const res: UrlPdfItem[] = [];

      const page = await this.browser.newPage();
      await this.initPage(page);

      for (const [index, item] of config.entries()) {
        console.log('开始处理', index, item);
        await page.goto(item.url, {
          timeout: 60 * 1000,
          waitUntil: ['networkidle0'],
        });

        const bodyHeight = await page.evaluate(() => {
          return document.documentElement.scrollHeight;
        });

        const pdfConfig = {
          printBackground: true,
          ...item.option,
        };
        if (bodyHeight > 14000) {
          pdfConfig.format = 'A4';
        } else {
          pdfConfig.height = `${bodyHeight}px`;
        }
        const pdfBuffer = await page.pdf({
          ...pdfConfig,
          ...item.option,
        });

        console.log('处理完成', index, item);
        res.push({
          name: `${index + 1}.${item.name}.pdf`,
          buffer: Buffer.from(pdfBuffer),
          headers: {
            'Content-Type': 'application/pdf',
          },
        });
      }

      if (!res.length) {
        throw new HttpException(
          '系统错误：未能生成PDF',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
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
      console.log(e);
      throw new HttpException(e, HttpStatus.INTERNAL_SERVER_ERROR);
    } finally {
      if (this.browser?.connected) {
        await this.browser.close();
        this.logger.debug(`close browser`);
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
    /**
     * 等待中的请求
     */
    const waitingRequests = {
      /**
       * url: isCompleted
       */
    };

    await page.setRequestInterception(true);

    /**
     * 注册请求的监听
     */
    page.on('request', (request) => {
      //  this.logger.verbose(`taskeSnapshot - screenshot: ${screenshotId} - request url: ${request.url()}`)
      if (!(request.url() in waitingRequests)) {
        console.log('1.waitingRequests', request.url());
        waitingRequests[request.url()] = false;
      }
      request.continue();
    });

    /**
     * 注册response的监听
     */
    page.on('response', (response) => {
      const requestUrl = response.request().url();
      console.log('2.response', requestUrl);

      waitingRequests[requestUrl] = true;
      // if (requestUrl === 'data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==') {
      //   this.logger.verbose(`taskeSnapshot - screenshot: ${screenshotId} - url ${requestUrl} has done.`)
      // }
    });

    const maxScrollTimes = options?.scrollTimes || 20;
    const minScrollTimes = options?.minScrollTimes || 5;
    const scrollDelay = options?.scrollDelay || 1000;
    const scrollOffset = parseInt(options?.scrollOffset?.toString()) || 1000;
    // 获取初始页面高度
    let previousHeight = await page.evaluate(() =>
      Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight,
      ),
    );
    let scrollCount = 0;
    let heightChanged = true;
    while (scrollCount < maxScrollTimes && heightChanged) {
      // 执行滚动
      await page.mouse.wheel({ deltaY: scrollOffset });

      // await page.waitForTimeout(scrollDelay);
      await this.sleep(scrollDelay);
      // 获取新的页面高度
      const currentHeight = await page.evaluate(() =>
        Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.clientHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight,
        ),
      );

      // 检查高度是否变化
      if (currentHeight === previousHeight && scrollCount > minScrollTimes) {
        heightChanged = false;
      } else {
        previousHeight = currentHeight;
        scrollCount++;
      }
    }
    await page.setRequestInterception(false);
    page.removeAllListeners('request');
    page.removeAllListeners('response');
  }
}
