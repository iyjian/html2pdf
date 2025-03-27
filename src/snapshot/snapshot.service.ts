import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Scope,
} from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import { Browser, Page, KnownDevices, PDFOptions } from 'puppeteer';
import { SnapshotOptionDto } from './../core/interfaces/requestDto';
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

  // constructor(private readonly alioss: AliossService) {}

  async init(debug = false) {
    if (!this.browser && this.isRunning === false) {
      this.isRunning = true;

      // puppeteer.use(StealthPlugin());

      this.browser = await puppeteer.launch({
        headless: false,
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
        // executablePath: path.join(__dirname, './../../chrome-linux/chrome'),
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

      return pdfBuffer;
    } catch (e) {
      throw new HttpException(
        '系统错误：未能生成PDF',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } finally {
      if (this.browser && this.browser.isConnected()) {
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

  async URL2PDF(url: string, pdfOption?: PDFOptions): Promise<Buffer> {
    console.log(url, pdfOption)
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

      return pdfBuffer;
    } catch (e) {
      console.log(e);
      throw new HttpException(
        '系统错误：未能生成PDF',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } finally {
      if (this.browser && this.browser.isConnected()) {
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
        waitingRequests[request.url()] = false;
      }
      request.continue();
    });

    /**
     * 注册response的监听
     */
    page.on('response', (response) => {
      const requestUrl = response.request().url();
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
    let previousHeight = await page.evaluate(() => Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
    ));
    let scrollCount = 0;
    let heightChanged = true;
    while (scrollCount < maxScrollTimes && heightChanged) {
      // 执行滚动
      await page.mouse.wheel({ deltaY: scrollOffset });

      await page.waitForTimeout(scrollDelay);
      // 获取新的页面高度
      const currentHeight = await page.evaluate(() => Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.clientHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight
      ));

      // 检查高度是否变化
      if (currentHeight === previousHeight && scrollCount > minScrollTimes) {
          heightChanged = false;
      } else {
          previousHeight = currentHeight;
          scrollCount++;
      }
  }
  }
}
