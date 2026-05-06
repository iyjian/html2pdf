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
  // 2. 网络空闲：等待 800ms idle，最多等 3200ms。
  // 3. 图片/视频：首次检查 + 3 次重试，每轮媒体等待最多 3200ms。
  private readonly urlPdfLoadOptions: SnapshotOptionDto = {
    scrollTimes: 20,
    minScrollTimes: 4,
    scrollDelay: 800,
    scrollOffset: 2000,
  };

  private readonly urlPdfMediaRetryTimes = 3;

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
      // 1. 参数校验：没有 URL 时不启动浏览器，直接返回请求错误。
      if (config.length === 0) {
        throw new HttpException(
          '参数错误：请提供至少一个URL',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 2. 初始化本次请求专用的 Chromium；本次请求内 newPage 共享同一个 browser context。
      await this.init();

      // 3. 把每个 URL 包成延迟执行任务，交给 sliceTasks 控制并发。
      const tasks = config.map((item, index) => {
        return () => this.renderUrlPdfItem(item, index);
      });

      // 4. 默认最多 10 个页面并发；可用 SNAPSHOT_URL_PDF_CONCURRENCY 调小。
      const res = await this.sliceTasks(tasks, this.urlPdfMaxConcurrent);

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
      this.logger.error('urlToPdf - failed', e);
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
    // 每个 URL 单独打开一个 page；并发时这些 page 会同时共享同一个 browser。
    const page = await this.browser.newPage();

    try {
      // 页面脚本初始化：禁用 unload/dialog 干扰，并设置 PDF 基础 viewport。
      await this.initPage(page);
      await this.initPdfViewport(page);

      // 首次导航只等 window load，最长 60s；懒加载、网络空闲和媒体加载在 waitPageLoaded 中处理。
      await page.goto(item.url, {
        timeout: 60 * 1000,
        waitUntil: ['load'],
      });

      // 页面稳定等待：默认约 3.2-16s 滚动 + 最多 3.2s 网络空闲 + 最多约 12.8s 媒体等待。
      await this.waitPageLoaded(page, this.urlPdfLoadOptions);

      // 懒加载完成后再测量页面尺寸，避免 PDF 高度少算。
      let { width: bodyWidth, height: bodyHeight } =
        await this.getPageDimensions(page);

      if (bodyWidth > this.getViewportWidth(page)) {
        // 宽页面需要扩展 viewport；扩展后可能触发响应式布局和新的懒加载，所以再等一次。
        await this.expandPdfViewport(page, bodyWidth);
        await this.waitPageLoaded(page, this.urlPdfLoadOptions);
        ({ width: bodyWidth, height: bodyHeight } =
          await this.getPageDimensions(page));
      }

      // 未指定 format 时，按完整页面像素尺寸输出；调用方传入的 PDFOptions 优先。
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

      // 图片/视频三次重试后仍失败只记录日志，不阻断 PDF 输出。
      const pdfBuffer = await page.pdf(pdfConfig);

      return {
        name: `${index + 1}.${item.name}.pdf`,
        buffer: Buffer.from(pdfBuffer),
        headers: {
          'Content-Type': 'application/pdf',
        },
      };
    } finally {
      // 无论成功或失败都关闭当前 page，避免批量导出时页面句柄泄漏。
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

    // 先向下滚动触发图片、视频、列表等懒加载内容；默认最多 20 轮，每轮等待 800ms。
    while (scrollCount < maxScrollTimes) {
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

      // 页面高度不再变化且已到底部/滚不动时记为稳定；默认连续 4 轮稳定后提前结束。
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
  ): Promise<void> {
    // 首轮只检查当前媒体状态；都已加载时立即返回，不额外等待。
    let status = await this.collectMediaLoadStatus(page, timeout);

    for (let retryIndex = 1; retryIndex <= retryTimes; retryIndex += 1) {
      if (status.failed.length === 0) {
        return;
      }

      this.logger.warn(
        `waitMediaLoaded - retry ${retryIndex}/${retryTimes}, failed ${status.failed.length}/${status.total}`,
      );
      // 对仍失败的 img/video 发起重试，然后再次等待其完成。
      await this.retryFailedMedia(page);
      status = await this.collectMediaLoadStatus(page, timeout);
    }

    if (status.failed.length > 0) {
      // 三次重试后仍失败只记录资源类型、数量和样例 URL，不 throw，继续生成 PDF。
      this.logger.error(
        `waitMediaLoaded - media failed after ${retryTimes} retries: ${this.formatMediaFailureSummary(
          status.failed,
        )}`,
      );
    }
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
