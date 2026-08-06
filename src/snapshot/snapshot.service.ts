import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Scope,
} from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import {
  Browser,
  HTTPRequest,
  HTTPResponse,
  Page,
  PDFOptions,
} from 'puppeteer';
import JSZip from 'jszip';
import { SnapshotOptionDto } from './../core/interfaces/requestDto';
import { UrlPdfItem } from './snapshot.interface';

interface UrlPdfMediaFailure {
  type: 'image' | 'video';
  url: string;
  reason: string;
}

interface UrlPdfMediaLoadStatus {
  total: number;
  loaded: number;
  failed: UrlPdfMediaFailure[];
}

interface UrlPdfNetworkMonitor {
  pending: Set<HTTPRequest>;
  failures: Set<string>;
  lastActivityAt: number;
  logLabel: string;
  dispose: () => void;
}

interface UrlPdfPageStableState {
  width: number;
  height: number;
  mediaCount: number;
}

interface UrlPdfVisualSettleStatus {
  transitionNodes: number;
  finiteAnimations: number;
  elapsedMs: number;
  timedOut: boolean;
}

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

  // urlToPdf 批量导出默认等待预算：
  // 1. 滚动触发懒加载：最多 20 轮 * 800ms，连续 4 轮稳定后提前结束。
  // 2. 页面资源等待：每次 pending 清零后持续 1200ms 才算稳定，整体最多 60s。
  // 3. 图片/视频：首次检查 + 3 次重试，每轮媒体等待最多 3200ms。
  private readonly urlPdfLoadOptions: SnapshotOptionDto = {
    scrollTimes: 20,
    minScrollTimes: 4,
    scrollDelay: 800,
    scrollOffset: 2000,
  };

  private readonly urlPdfMediaRetryTimes = 3;

  private readonly urlPdfNetworkIdleTime = 1200;

  private readonly urlPdfReadyTimeout = 60 * 1000;

  private readonly urlPdfRenderRetryTimes = 1;

  private readonly urlPdfDomStableRounds = 3;

  private readonly urlPdfDomStableInterval = 200;

  private readonly urlPdfVisualSettleTimeout = 3000;

  private readonly urlPdfTrackedResourceTypes = new Set([
    'document',
    'stylesheet',
    'script',
    'xhr',
    'fetch',
    'image',
    'media',
    'font',
  ]);

  /**
   * 浏览器实例
   */
  private browser: Browser;

  /**
   * 页面实例
   */
  private page: Page;

  private isRunning = false;

  // Chromium 同一时刻只有一个前台 Page；用队列串行化最终视觉渲染和 PDF 打印。
  private urlPdfVisualRenderQueue: Promise<void> = Promise.resolve();

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
            this.logger.error(
              `PDF生成任务失败: ${this.getUrlPdfSafeErrorSummary(e)}`,
            );
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
    const batchStartedAt = Date.now();

    try {
      // 1. 参数校验：没有 URL 时不启动浏览器，直接返回请求错误。
      if (config.length === 0) {
        throw new HttpException(
          '参数错误：请提供至少一个URL',
          HttpStatus.BAD_REQUEST,
        );
      }

      this.logger.log(
        `[urlToPdf] 批次开始: pages=${config.length}, concurrency=${this.urlPdfMaxConcurrent}`,
      );

      // 2. 初始化本次请求专用的 Chromium；本次请求内 newPage 共享同一个 browser context。
      await this.init();

      // 3. 把每个 URL 包成延迟执行任务，交给 sliceTasks 控制并发。
      const tasks = config.map((item, index) => {
        return () => this.renderUrlPdfItem(item, index);
      });

      // 4. 默认最多 10 个页面并发；可用 SNAPSHOT_URL_PDF_CONCURRENCY 调小。
      const res = await this.sliceTasks(tasks, this.urlPdfMaxConcurrent);
      this.logger.log(
        `[urlToPdf] 页面渲染完成: pages=${res.length}, elapsedMs=${
          Date.now() - batchStartedAt
        }`,
      );

      // 5. 输出规则：单个 PDF 直接返回；多个 PDF 或传入 zipName 时打包为 ZIP。
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
      this.logger.error(
        `[urlToPdf] 批次失败: elapsedMs=${
          Date.now() - batchStartedAt
        }, error=${this.getUrlPdfSafeErrorSummary(e)}`,
      );
      throw new HttpException(e, HttpStatus.INTERNAL_SERVER_ERROR);
    } finally {
      // 6. 请求结束后关闭浏览器，避免 localStorage/token 在不同请求之间残留。
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
    let lastError: unknown;
    const logLabel = this.getUrlPdfLogLabel(item.name, index);

    // 资源等待失败时使用全新的 page 完整重试一次，避免复用已进入异常状态的页面。
    for (
      let attempt = 0;
      attempt <= this.urlPdfRenderRetryTimes;
      attempt += 1
    ) {
      const attemptStartedAt = Date.now();
      this.logger.debug(
        `${logLabel} 开始渲染: attempt=${attempt + 1}/${
          this.urlPdfRenderRetryTimes + 1
        }`,
      );

      try {
        const result = await this.renderUrlPdfItemOnce(item, index, logLabel);
        this.logger.log(
          `${logLabel} 渲染成功: attempt=${attempt + 1}, elapsedMs=${
            Date.now() - attemptStartedAt
          }, pdfBytes=${result.buffer.length}`,
        );
        return result;
      } catch (e) {
        lastError = e;
        this.logger.warn(
          `${logLabel} 渲染失败: attempt=${attempt + 1}, elapsedMs=${
            Date.now() - attemptStartedAt
          }, error=${this.getUrlPdfSafeErrorSummary(e)}`,
        );
      }
    }

    throw lastError;
  }

  private async renderUrlPdfItemOnce(
    item: {
      url: string;
      name: string;
      option: PDFOptions;
    },
    index: number,
    logLabel = this.getUrlPdfLogLabel(item.name, index),
  ): Promise<UrlPdfItem> {
    // 每个 URL 单独打开一个 page；并发时这些 page 会同时共享同一个 browser。
    const page = await this.browser.newPage();
    // 必须在 goto 前开始监听，否则会漏掉页面初始化阶段发出的接口和资源请求。
    const networkMonitor = this.createUrlPdfNetworkMonitor(page, logLabel);

    try {
      // 页面脚本初始化：禁用 unload/dialog 干扰，并设置 PDF 基础 viewport。
      await this.initPage(page);
      await this.initPdfViewport(page);

      // 首次导航只等 window load，最长 60s；后续由严格就绪流程处理懒加载、网络和媒体。
      await page.goto(item.url, {
        timeout: 60 * 1000,
        waitUntil: ['load'],
      });
      this.logger.debug(`${logLabel} 页面 load 事件完成`);

      const readyDeadlineAt = Date.now() + this.urlPdfReadyTimeout;

      // 先等待主数据请求结束，再滚动触发懒加载，最后严格等待网络、媒体和页面尺寸稳定。
      await this.waitUrlPdfPageReady(
        page,
        networkMonitor,
        readyDeadlineAt,
        this.urlPdfLoadOptions,
      );
      this.logger.debug(`${logLabel} 首轮页面就绪检查完成`);

      // 懒加载完成后再测量页面尺寸，避免 PDF 高度少算。
      let { width: bodyWidth, height: bodyHeight } =
        await this.getPageDimensions(page);

      if (bodyWidth > this.getViewportWidth(page)) {
        // 宽页面需要扩展 viewport；扩展后可能触发响应式布局和新的懒加载，所以再等一次。
        this.logger.debug(
          `${logLabel} 扩展 viewport: from=${this.getViewportWidth(
            page,
          )}, to=${Math.ceil(bodyWidth)}`,
        );
        await this.expandPdfViewport(page, bodyWidth);
        await this.waitUrlPdfPageReady(
          page,
          networkMonitor,
          readyDeadlineAt,
          this.urlPdfLoadOptions,
        );
        ({ width: bodyWidth, height: bodyHeight } =
          await this.getPageDimensions(page));
        this.logger.debug(`${logLabel} viewport 变更后的就绪检查完成`);
      }

      const pdfBuffer = await this.runWithUrlPdfVisualRenderLock(
        logLabel,
        async () => {
          // 批量场景下后台 Page 的 requestAnimationFrame 会暂停；切到前台后推进过渡帧。
          await this.waitForUrlPdfVisualSettled(
            page,
            readyDeadlineAt,
            logLabel,
          );

          // 视觉过渡可能改变布局；前台稳定后重新执行最终闸门并重新测量 PDF 尺寸。
          await this.waitUrlPdfFinalReady(
            page,
            networkMonitor,
            readyDeadlineAt,
          );
          ({ width: bodyWidth, height: bodyHeight } =
            await this.getPageDimensions(page));

          // 未指定 format 时，按最终完整页面像素尺寸输出；调用方传入的 PDFOptions 优先。
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

          this.logger.debug(
            `${logLabel} PDF 前最终闸门通过: width=${bodyWidth}, height=${bodyHeight}`,
          );
          // 必须在仍持有视觉锁时打印，防止其他 Page 抢到前台后再次暂停当前渲染。
          return await page.pdf(pdfConfig);
        },
      );

      return {
        name: `${index + 1}.${item.name}.pdf`,
        buffer: Buffer.from(pdfBuffer),
        headers: {
          'Content-Type': 'application/pdf',
        },
      };
    } finally {
      // 无论成功或失败都关闭当前 page，避免批量导出时页面句柄泄漏。
      networkMonitor.dispose();
      if (!page.isClosed()) {
        await page.close();
      }
    }
  }

  /**
   * 构造单页日志标识。文件名会清理换行并限制长度，避免批量日志被用户输入打断。
   */
  private getUrlPdfLogLabel(name: string, index: number): string {
    const safeName = String(name || '')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 120);
    return `[urlToPdf][page=${index + 1}][name=${safeName}]`;
  }

  /**
   * 日志中保留错误类型和原因，但隐藏完整 URL、token 等敏感信息。
   */
  private getUrlPdfSafeErrorSummary(error: unknown): string {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = rawMessage
      .replace(/https?:\/\/[^\s)\]}]+/gi, '[URL已隐藏]')
      .replace(
        /((?:token|access_token|authorization)\s*[=:]\s*)[^\s,;&]+/gi,
        '$1***',
      )
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 500);

    return `${errorName}: ${safeMessage}`;
  }

  /**
   * 将最终视觉稳定和 page.pdf 串行执行。网络和媒体仍可并发加载，只有依赖前台状态的阶段排队。
   */
  private async runWithUrlPdfVisualRenderLock<T>(
    logLabel: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const queuedAt = Date.now();
    const previousTask = this.urlPdfVisualRenderQueue;
    let release: () => void = () => undefined;
    this.urlPdfVisualRenderQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousTask;
    this.logger.debug(
      `${logLabel} 获得最终渲染锁: queueWaitMs=${Date.now() - queuedAt}`,
    );

    try {
      return await task();
    } finally {
      // 无论视觉检查或 PDF 打印是否失败，都必须释放后续页面。
      release();
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

  /**
   * 从导航前开始维护有限 HTTP 资源的 pending/failed 集合。
   * requestfinished 和 requestfailed 都会结束 pending；HTTP 4xx/5xx 另外记为失败。
   */
  private createUrlPdfNetworkMonitor(
    page: Page,
    logLabel = '[urlToPdf]',
  ): UrlPdfNetworkMonitor {
    const monitor: UrlPdfNetworkMonitor = {
      pending: new Set(),
      failures: new Set(),
      lastActivityAt: Date.now(),
      logLabel,
      dispose: () => undefined,
    };

    const touch = () => {
      monitor.lastActivityAt = Date.now();
    };
    const onRequest = (request: HTTPRequest) => {
      if (!this.isTrackedUrlPdfRequest(request)) {
        return;
      }

      // 使用 HTTPRequest 实例作为 Set key，可正确区分同一 URL 的并发请求。
      monitor.pending.add(request);
      touch();
    };
    const onRequestFinished = (request: HTTPRequest) => {
      if (monitor.pending.delete(request)) {
        touch();
      }
    };
    const onRequestFailed = (request: HTTPRequest) => {
      if (!monitor.pending.has(request)) {
        return;
      }

      monitor.pending.delete(request);
      monitor.failures.add(this.getUrlPdfRequestKey(request));
      touch();
    };
    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!this.isTrackedUrlPdfRequest(request)) {
        return;
      }

      const key = this.getUrlPdfRequestKey(request);
      if (response.status() >= 400) {
        monitor.failures.add(key);
      } else {
        // 同一资源后续重试成功时，清除之前记录的瞬时失败。
        monitor.failures.delete(key);
      }
      touch();
    };

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);

    monitor.dispose = () => {
      // Page 关闭前主动解绑，避免重试时旧监听器和请求状态残留。
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
      monitor.pending.clear();
    };

    return monitor;
  }

  private isTrackedUrlPdfRequest(request: HTTPRequest): boolean {
    const resourceType = request.resourceType();
    if (!this.urlPdfTrackedResourceTypes.has(resourceType)) {
      return false;
    }

    const url = request.url();
    if (/^(?:data|blob|about):/i.test(url)) {
      return false;
    }

    // favicon 不影响 PDF 内容，并且目标页面当前会返回 404，避免它阻断整批导出。
    return !/\/favicon(?:\.[^/?#]+)?(?:[?#].*)?$/i.test(url);
  }

  private getUrlPdfRequestKey(request: HTTPRequest): string {
    return `${request.resourceType()}:${request.method()}:${request.url()}`;
  }

  private async waitUrlPdfPageReady(
    page: Page,
    monitor: UrlPdfNetworkMonitor,
    deadlineAt: number,
    options: SnapshotOptionDto,
  ): Promise<void> {
    // 先等待页面主数据和附件元数据请求结束，避免 DOM 中的 img 尚未创建。
    await this.waitForUrlPdfNetworkSettled(monitor, deadlineAt);
    await this.scrollPageForLazyResources(
      page,
      options,
      deadlineAt,
      monitor.logLabel,
    );
    await this.waitUrlPdfFinalReady(page, monitor, deadlineAt);
  }

  /**
   * 将当前 Page 切到前台并推进浏览器绘制帧，等待有限动画和 Vue/Element 过渡节点退出。
   * 批量打开 Page 时后台页的 requestAnimationFrame 可能暂停，仅检查 Network/img.complete 不足以
   * 证明图片已经进入最终布局。
   */
  private async waitForUrlPdfVisualSettled(
    page: Page,
    deadlineAt: number,
    logLabel: string,
  ): Promise<void> {
    this.assertUrlPdfReadyDeadline(deadlineAt);
    const timeout = Math.max(
      Math.min(this.urlPdfVisualSettleTimeout, deadlineAt - Date.now()),
      1,
    );

    await page.bringToFront();
    const evaluateTask = page.evaluate(async (timeoutMs) => {
      const startedAt = performance.now();
      const waitFrame = () => {
        return new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      };
      const wait = (ms: number) => {
        return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
      };
      const getTransitionNodeCount = () => {
        return document.querySelectorAll(
          '[class*="-leave-active"], [class*="-enter-active"]',
        ).length;
      };
      const getFiniteRunningAnimations = () => {
        return document.getAnimations().filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return (
            animation.playState !== 'finished' &&
            animation.playState !== 'idle' &&
            Number.isFinite(Number(timing?.endTime))
          );
        });
      };

      let finiteAnimationCount = 0;
      while (performance.now() - startedAt < timeoutMs) {
        // Vue Transition 使用连续两个 requestAnimationFrame 切换 from/to class。
        await waitFrame();
        await waitFrame();

        const animations = getFiniteRunningAnimations();
        finiteAnimationCount = Math.max(
          finiteAnimationCount,
          animations.length,
        );
        if (animations.length > 0) {
          const remainingTime = Math.max(
            timeoutMs - (performance.now() - startedAt),
            1,
          );
          await Promise.race([
            Promise.all(
              animations.map((animation) =>
                animation.finished.catch(() => undefined),
              ),
            ),
            wait(remainingTime),
          ]);
        }

        // transitionend 后 Vue 还需要一个绘制帧移除离场节点。
        await waitFrame();
        const transitionNodes = getTransitionNodeCount();
        if (
          transitionNodes === 0 &&
          getFiniteRunningAnimations().length === 0
        ) {
          return {
            transitionNodes,
            finiteAnimations: finiteAnimationCount,
            elapsedMs: Math.round(performance.now() - startedAt),
            timedOut: false,
          };
        }

        await wait(50);
      }

      return {
        transitionNodes: getTransitionNodeCount(),
        finiteAnimations: finiteAnimationCount,
        elapsedMs: Math.round(performance.now() - startedAt),
        timedOut: true,
      };
    }, timeout);

    // Node 侧也设置超时，避免 Page 再次失去前台时 requestAnimationFrame 永久不返回。
    const status = await new Promise<UrlPdfVisualSettleStatus>(
      (resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('页面视觉渲染等待超时'));
        }, timeout + 250);

        void evaluateTask.then(
          (result) => {
            clearTimeout(timeoutId);
            resolve(result as UrlPdfVisualSettleStatus);
          },
          (error) => {
            clearTimeout(timeoutId);
            reject(error);
          },
        );
      },
    );

    if (status.timedOut || status.transitionNodes > 0) {
      this.logger.warn(
        `${logLabel} 页面视觉渲染未完成: transitionNodes=${status.transitionNodes}, finiteAnimations=${status.finiteAnimations}, elapsedMs=${status.elapsedMs}`,
      );
      throw new Error(
        `页面视觉渲染等待超时：仍有 ${status.transitionNodes} 个过渡节点`,
      );
    }

    this.logger.debug(
      `${logLabel} 页面视觉渲染已稳定: finiteAnimations=${status.finiteAnimations}, elapsedMs=${status.elapsedMs}`,
    );
  }

  /**
   * PDF 就绪闸门：网络稳定 -> 媒体完成 -> 网络再次稳定 -> DOM 稳定 -> 最终网络稳定。
   * 媒体重试和 Vue 渲染都可能产生新请求，因此不能只检查一次 network idle。
   */
  private async waitUrlPdfFinalReady(
    page: Page,
    monitor: UrlPdfNetworkMonitor,
    deadlineAt: number,
  ): Promise<void> {
    await this.waitForUrlPdfNetworkSettled(monitor, deadlineAt);
    await this.waitMediaLoaded(
      page,
      this.urlPdfMediaRetryTimes,
      Math.max(this.urlPdfLoadOptions.scrollDelay * 4, 3000),
      true,
      deadlineAt,
      monitor.logLabel,
    );
    // 媒体重试可能重新发起请求，因此媒体检查后必须再次等待 pending 清零。
    await this.waitForUrlPdfNetworkSettled(monitor, deadlineAt);
    await this.waitForUrlPdfDomStable(page, deadlineAt, monitor.logLabel);
    // DOM 稳定期间仍可能调度请求，page.pdf 前再执行最后一次网络闸门。
    await this.waitForUrlPdfNetworkSettled(monitor, deadlineAt);
    this.assertUrlPdfNetworkSucceeded(monitor);
    this.logger.debug(
      `${monitor.logLabel} 最终就绪闸门通过: pending=${monitor.pending.size}, failed=${monitor.failures.size}`,
    );
  }

  /**
   * pending 清零后必须持续 idleTime 无新活动才返回；deadlineAt 是整页共享的总预算。
   */
  private async waitForUrlPdfNetworkSettled(
    monitor: UrlPdfNetworkMonitor,
    deadlineAt: number,
    idleTime = this.urlPdfNetworkIdleTime,
  ): Promise<void> {
    while (Date.now() < deadlineAt) {
      const now = Date.now();
      if (
        monitor.pending.size === 0 &&
        now - monitor.lastActivityAt >= idleTime
      ) {
        this.logger.debug(
          `${monitor.logLabel} Network 已稳定: pending=0, idleMs=${
            now - monitor.lastActivityAt
          }, failed=${monitor.failures.size}`,
        );
        return;
      }

      const remainingTime = deadlineAt - now;
      const remainingIdleTime = Math.max(
        idleTime - (now - monitor.lastActivityAt),
        1,
      );
      await this.sleep(Math.min(50, remainingTime, remainingIdleTime));
    }

    this.logger.warn(
      `${monitor.logLabel} Network 等待超时: pending=${monitor.pending.size}, failed=${monitor.failures.size}`,
    );
    throw new Error(
      `页面资源等待超时：仍有 ${monitor.pending.size} 个请求未结束`,
    );
  }

  private assertUrlPdfNetworkSucceeded(monitor: UrlPdfNetworkMonitor): void {
    if (monitor.failures.size > 0) {
      this.logger.warn(
        `${monitor.logLabel} 关键资源请求失败: failed=${monitor.failures.size}`,
      );
      throw new Error(`页面存在 ${monitor.failures.size} 个关键资源请求失败`);
    }
  }

  /**
   * 连续多轮比较页面宽高和媒体元素数量，防止请求完成后 Vue/DOM 尚未完成下一轮渲染。
   */
  private async waitForUrlPdfDomStable(
    page: Page,
    deadlineAt: number,
    logLabel = '[urlToPdf]',
  ): Promise<void> {
    let previousState = await this.getUrlPdfPageStableState(page);
    let stableRounds = 0;

    while (stableRounds < this.urlPdfDomStableRounds) {
      this.assertUrlPdfReadyDeadline(deadlineAt);
      await this.sleep(
        Math.min(this.urlPdfDomStableInterval, deadlineAt - Date.now()),
      );

      const currentState = await this.getUrlPdfPageStableState(page);
      if (
        currentState.width === previousState.width &&
        currentState.height === previousState.height &&
        currentState.mediaCount === previousState.mediaCount
      ) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }
      previousState = currentState;
    }

    this.logger.debug(
      `${logLabel} DOM 已稳定: width=${previousState.width}, height=${previousState.height}, media=${previousState.mediaCount}`,
    );
  }

  private async getUrlPdfPageStableState(
    page: Page,
  ): Promise<UrlPdfPageStableState> {
    return await page.evaluate(() => {
      const body = document.body;
      const documentElement = document.documentElement;

      return {
        width: Math.max(
          body?.scrollWidth || 0,
          documentElement?.scrollWidth || 0,
        ),
        height: Math.max(
          body?.scrollHeight || 0,
          documentElement?.scrollHeight || 0,
        ),
        mediaCount:
          document.images.length + document.querySelectorAll('video').length,
      };
    });
  }

  private assertUrlPdfReadyDeadline(deadlineAt: number): void {
    if (Date.now() >= deadlineAt) {
      throw new Error('页面资源等待超时');
    }
  }

  private async scrollPageForLazyResources(
    page: Page,
    options?: SnapshotOptionDto,
    deadlineAt?: number,
    logLabel = '[urlToPdf]',
  ): Promise<void> {
    const maxScrollTimes = options?.scrollTimes || 20;
    const minStableScrollRounds = Math.max(options?.minScrollTimes || 5, 1);
    const scrollDelay = options?.scrollDelay || 1000;
    const scrollOffset = parseInt(options?.scrollOffset?.toString()) || 1000;
    let scrollCount = 0;
    let stableScrollRounds = 0;
    let previousState = await this.getPageScrollState(page);

    // 逐段滚动触发图片、视频和列表懒加载；到底且高度连续稳定后提前停止。
    while (scrollCount < maxScrollTimes) {
      if (deadlineAt !== undefined) {
        this.assertUrlPdfReadyDeadline(deadlineAt);
      }

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
    this.logger.debug(
      `${logLabel} 懒加载滚动完成: rounds=${scrollCount}, stableRounds=${stableScrollRounds}`,
    );
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
    const scrollDelay = options?.scrollDelay || 1000;
    await this.scrollPageForLazyResources(
      page,
      options,
      undefined,
      '[URL2PDF]',
    );
    try {
      // 滚动结束后等一次短网络空闲；默认等 800ms idle，最多等 3200ms，超时只告警。
      await page.waitForNetworkIdle({
        idleTime: scrollDelay,
        timeout: Math.max(scrollDelay * 4, 1500),
      });
    } catch (e) {
      this.logger.warn('waitPageLoaded - network idle timeout');
    }
    try {
      // 最后显式等待 img/video；默认首次检查 + 3 次重试，每次最多 3200ms。
      await this.waitMediaLoaded(
        page,
        this.urlPdfMediaRetryTimes,
        Math.max(scrollDelay * 4, 3000),
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `waitPageLoaded - media wait failed, continue PDF: ${errorMessage}`,
      );
    }
  }

  private async waitMediaLoaded(
    page: Page,
    retryTimes = 3,
    timeout = 3000,
    strict = false,
    deadlineAt?: number,
    logLabel = '[urlToPdf]',
  ): Promise<void> {
    // 首轮只检查当前媒体状态；都已加载时立即返回，不额外等待。
    let status = await this.collectMediaLoadStatus(
      page,
      this.getUrlPdfMediaWaitTimeout(timeout, deadlineAt),
    );
    if (status.failed.length === 0) {
      if (strict) {
        this.logger.debug(
          `${logLabel} 媒体资源已就绪: loaded=${status.loaded}, total=${status.total}`,
        );
      }
      return;
    }

    for (let retryIndex = 1; retryIndex <= retryTimes; retryIndex += 1) {
      this.logger.warn(
        `waitMediaLoaded - retry ${retryIndex}/${retryTimes}, failed ${status.failed.length}/${status.total}`,
      );
      // 对仍失败的 img/video 发起重试，然后再次等待其完成。
      await this.retryFailedMedia(page);
      status = await this.collectMediaLoadStatus(
        page,
        this.getUrlPdfMediaWaitTimeout(timeout, deadlineAt),
      );
      if (status.failed.length === 0) {
        if (strict) {
          this.logger.debug(
            `${logLabel} 媒体资源重试成功: retry=${retryIndex}, loaded=${status.loaded}, total=${status.total}`,
          );
        }
        return;
      }
    }

    if (status.failed.length > 0) {
      if (strict) {
        this.logger.warn(
          `${logLabel} 媒体资源加载失败: failed=${status.failed.length}, total=${status.total}`,
        );
        throw new Error(`页面存在 ${status.failed.length} 个媒体资源加载失败`);
      }

      // 三次重试后仍失败只记录资源类型、数量和样例 URL，不 throw，继续生成 PDF。
      this.logger.error(
        `waitMediaLoaded - media failed after ${retryTimes} retries: ${this.formatMediaFailureSummary(
          status.failed,
        )}`,
      );
    }
  }

  private getUrlPdfMediaWaitTimeout(
    timeout: number,
    deadlineAt?: number,
  ): number {
    if (deadlineAt === undefined) {
      return timeout;
    }

    this.assertUrlPdfReadyDeadline(deadlineAt);
    return Math.max(Math.min(timeout, deadlineAt - Date.now()), 1);
  }

  private async collectMediaLoadStatus(
    page: Page,
    timeout: number,
  ): Promise<UrlPdfMediaLoadStatus> {
    return await page.evaluate(async (timeoutMs) => {
      // 单个媒体等待使用超时保护，避免一个坏资源卡住整个 PDF。
      const waitWithTimeout = <T, U>(
        promise: Promise<T>,
        timeoutValue: U,
      ): Promise<T | U> => {
        return Promise.race([
          promise,
          new Promise<U>((resolve) => {
            window.setTimeout(() => resolve(timeoutValue), timeoutMs);
          }),
        ]);
      };

      const getImageUrl = (image: HTMLImageElement): string => {
        return (
          image.currentSrc ||
          image.src ||
          image.getAttribute('src') ||
          image.getAttribute('srcset') ||
          ''
        );
      };

      const getVideoUrl = (video: HTMLVideoElement): string => {
        return (
          video.currentSrc ||
          video.src ||
          video.getAttribute('src') ||
          video.querySelector('source')?.src ||
          video.querySelector('source')?.getAttribute('src') ||
          ''
        );
      };

      const isImageReady = (image: HTMLImageElement): boolean => {
        return (
          image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
        );
      };

      const waitImage = async (
        image: HTMLImageElement,
      ): Promise<UrlPdfMediaFailure | null> => {
        const url = getImageUrl(image);
        if (!url) {
          return null;
        }

        image.loading = 'eager';

        // 图片必须 complete 且有 naturalWidth/naturalHeight；能 decode 时再尝试解码。
        if (isImageReady(image)) {
          if (typeof image.decode === 'function') {
            await waitWithTimeout(
              image.decode().catch(() => undefined),
              null,
            );
          }
          return isImageReady(image)
            ? null
            : { type: 'image', url, reason: 'image-decode-not-ready' };
        }

        if (image.complete) {
          return { type: 'image', url, reason: 'image-error' };
        }

        const loadResult = await waitWithTimeout(
          new Promise<'load' | 'error'>((resolve) => {
            const cleanup = () => {
              image.removeEventListener('load', handleLoad);
              image.removeEventListener('error', handleError);
            };
            const handleLoad = () => {
              cleanup();
              resolve('load');
            };
            const handleError = () => {
              cleanup();
              resolve('error');
            };

            image.addEventListener('load', handleLoad, { once: true });
            image.addEventListener('error', handleError, { once: true });
          }),
          'timeout',
        );

        if (loadResult === 'load' && typeof image.decode === 'function') {
          await waitWithTimeout(
            image.decode().catch(() => undefined),
            null,
          );
        }

        return isImageReady(image)
          ? null
          : {
              type: 'image',
              url,
              reason:
                loadResult === 'timeout' ? 'image-timeout' : 'image-error',
            };
      };

      const isVideoReady = (video: HTMLVideoElement): boolean => {
        return video.readyState >= 2;
      };

      const waitVideo = async (
        video: HTMLVideoElement,
      ): Promise<UrlPdfMediaFailure | null> => {
        const url = getVideoUrl(video);
        if (!url) {
          return null;
        }

        video.preload = 'auto';

        // video.readyState >= 2 表示当前帧可用，PDF 打印时能拿到画面。
        if (isVideoReady(video)) {
          return null;
        }

        const loadResult = await waitWithTimeout(
          new Promise<'load' | 'error'>((resolve) => {
            const cleanup = () => {
              video.removeEventListener('loadeddata', handleLoad);
              video.removeEventListener('canplay', handleLoad);
              video.removeEventListener('error', handleError);
              video.removeEventListener('abort', handleError);
            };
            const handleLoad = () => {
              cleanup();
              resolve('load');
            };
            const handleError = () => {
              cleanup();
              resolve('error');
            };

            video.addEventListener('loadeddata', handleLoad, { once: true });
            video.addEventListener('canplay', handleLoad, { once: true });
            video.addEventListener('error', handleError, { once: true });
            video.addEventListener('abort', handleError, { once: true });
          }),
          'timeout',
        );

        return isVideoReady(video)
          ? null
          : {
              type: 'video',
              url,
              reason:
                loadResult === 'timeout' ? 'video-timeout' : 'video-error',
            };
      };

      const images = Array.from(document.images);
      const videos = Array.from(document.querySelectorAll('video'));
      // 同一页面内的图片/视频并行等待，整体等待时长由 timeout 控制。
      const results = await Promise.all([
        ...images.map((image) => waitImage(image)),
        ...videos.map((video) => waitVideo(video)),
      ]);
      const failed = results.filter(Boolean) as UrlPdfMediaFailure[];

      return {
        total: images.length + videos.length,
        loaded: images.length + videos.length - failed.length,
        failed,
      };
    }, timeout);
  }

  private async retryFailedMedia(page: Page): Promise<void> {
    await page.evaluate(() => {
      const isImageReady = (image: HTMLImageElement): boolean => {
        return (
          image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
        );
      };

      Array.from(document.images).forEach((image) => {
        if (isImageReady(image)) {
          return;
        }

        const src = image.getAttribute('src');
        const srcset = image.getAttribute('srcset');
        const currentSrc = image.currentSrc || image.src;

        if (!src && !srcset && !currentSrc) {
          return;
        }

        image.loading = 'eager';
        image.decoding = 'sync';

        // 通过移除再恢复 src/srcset，让浏览器重新请求或重新解码图片。
        if (srcset) {
          image.removeAttribute('srcset');
        }
        if (src) {
          image.removeAttribute('src');
        }

        void image.offsetHeight;

        if (src) {
          image.setAttribute('src', src);
        } else if (currentSrc) {
          image.src = currentSrc;
        }
        if (srcset) {
          image.setAttribute('srcset', srcset);
        }
      });

      Array.from(document.querySelectorAll('video')).forEach((video) => {
        if (video.readyState >= 2) {
          return;
        }

        video.preload = 'auto';
        try {
          // load() 会重新选择并加载当前 video source。
          video.load();
        } catch (e) {
          // Ignore retry failures here; collectMediaLoadStatus reports them.
        }
      });
    });
  }

  private formatMediaFailureSummary(failures: UrlPdfMediaFailure[]): string {
    const imageCount = failures.filter((item) => item.type === 'image').length;
    const videoCount = failures.filter((item) => item.type === 'video').length;
    const samples = failures.slice(0, 5).map((item) => {
      return `${item.type}:${item.reason}:${item.url}`;
    });

    return `total=${
      failures.length
    }, image=${imageCount}, video=${videoCount}, samples=${JSON.stringify(
      samples,
    )}`;
  }
}
