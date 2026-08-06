import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'events';
import { SnapshotService } from './snapshot.service';

describe('SnapshotService', () => {
  let service: SnapshotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SnapshotService],
    }).compile();

    service = await module.resolve<SnapshotService>(SnapshotService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('sliceTasks should preserve task order while limiting concurrency', async () => {
    let activeCount = 0;
    let maxActiveCount = 0;
    const delays = [30, 10, 20, 5];

    const tasks = delays.map((delay, index) => {
      return async () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, delay));
        activeCount -= 1;
        return index;
      };
    });

    const result = await service.sliceTasks(tasks, 2);

    expect(result).toEqual([0, 1, 2, 3]);
    expect(maxActiveCount).toBeLessThanOrEqual(2);
  });

  it('sliceTasks should return an empty array when there are no tasks', async () => {
    await expect(service.sliceTasks([], 2)).resolves.toEqual([]);
  });

  it('waitMediaLoaded should return when media is already loaded', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValueOnce({
        total: 2,
        loaded: 2,
        failed: [],
      }),
    };

    await (service as any).waitMediaLoaded(page, 3, 1);

    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('waitMediaLoaded should retry failed media and return after success', async () => {
    const page = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce({
          total: 2,
          loaded: 0,
          failed: [
            {
              type: 'image',
              url: 'https://example.com/a.png',
              reason: 'image-timeout',
            },
            {
              type: 'video',
              url: 'https://example.com/a.mp4',
              reason: 'video-timeout',
            },
          ],
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          total: 2,
          loaded: 2,
          failed: [],
        }),
    };
    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await (service as any).waitMediaLoaded(page, 3, 1);

    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      'waitMediaLoaded - retry 1/3, failed 2/2',
    );
  });

  it('waitMediaLoaded should log and continue when media still fails after retries', async () => {
    const failedStatus = {
      total: 2,
      loaded: 0,
      failed: [
        {
          type: 'image',
          url: 'https://example.com/a.png',
          reason: 'image-error',
        },
        {
          type: 'video',
          url: 'https://example.com/a.mp4',
          reason: 'video-error',
        },
      ],
    };
    const page = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce(failedStatus)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(failedStatus)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(failedStatus)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(failedStatus),
    };
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).waitMediaLoaded(page, 3, 1),
    ).resolves.toBeUndefined();

    expect(page.evaluate).toHaveBeenCalledTimes(7);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('waitMediaLoaded - media failed after 3 retries'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('image=1'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('video=1'));
  });

  it('waitMediaLoaded should throw in strict mode when media still fails', async () => {
    const failedStatus = {
      total: 1,
      loaded: 0,
      failed: [
        {
          type: 'image',
          url: 'https://example.com/a.png',
          reason: 'image-error',
        },
      ],
    };
    const page = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce(failedStatus)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(failedStatus),
    };

    await expect(
      (service as any).waitMediaLoaded(page, 1, 1, true),
    ).rejects.toThrow('页面存在 1 个媒体资源加载失败');
  });

  it('network monitor should wait until pending requests finish and remain idle', async () => {
    const page = new EventEmitter();
    const request = {
      resourceType: () => 'xhr',
      method: () => 'GET',
      url: () => 'https://example.com/api/attachment/1',
    };
    const monitor = (service as any).createUrlPdfNetworkMonitor(page);

    page.emit('request', request);
    const startedAt = Date.now();
    const waiting = (service as any).waitForUrlPdfNetworkSettled(
      monitor,
      Date.now() + 200,
      10,
    );
    setTimeout(() => page.emit('requestfinished', request), 20);

    await waiting;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
    expect(monitor.pending.size).toBe(0);
    monitor.dispose();
  });

  it('network monitor should throw when a request remains pending until deadline', async () => {
    const page = new EventEmitter();
    const request = {
      resourceType: () => 'xhr',
      method: () => 'GET',
      url: () => 'https://example.com/api/attachment/1',
    };
    const monitor = (service as any).createUrlPdfNetworkMonitor(page);

    page.emit('request', request);

    await expect(
      (service as any).waitForUrlPdfNetworkSettled(monitor, Date.now() + 20, 5),
    ).rejects.toThrow('仍有 1 个请求未结束');
    monitor.dispose();
  });

  it('network monitor should reject failed resources but allow a successful retry', () => {
    const page = new EventEmitter();
    const createRequest = () => ({
      resourceType: () => 'xhr',
      method: () => 'GET',
      url: () => 'https://example.com/api/attachment/1',
    });
    const monitor = (service as any).createUrlPdfNetworkMonitor(page);
    const failedRequest = createRequest();

    page.emit('request', failedRequest);
    page.emit('response', {
      request: () => failedRequest,
      status: () => 500,
    });
    page.emit('requestfinished', failedRequest);

    expect(() =>
      (service as any).assertUrlPdfNetworkSucceeded(monitor),
    ).toThrow('页面存在 1 个关键资源请求失败');

    const retriedRequest = createRequest();
    page.emit('request', retriedRequest);
    page.emit('response', {
      request: () => retriedRequest,
      status: () => 200,
    });
    page.emit('requestfinished', retriedRequest);

    expect(() =>
      (service as any).assertUrlPdfNetworkSucceeded(monitor),
    ).not.toThrow();
    monitor.dispose();
  });

  it('network monitor should ignore favicon and long-lived connections', () => {
    const page = new EventEmitter();
    const monitor = (service as any).createUrlPdfNetworkMonitor(page);
    const faviconRequest = {
      resourceType: () => 'image',
      method: () => 'GET',
      url: () => 'https://example.com/favicon.ico',
    };
    const webSocketRequest = {
      resourceType: () => 'websocket',
      method: () => 'GET',
      url: () => 'wss://example.com/socket',
    };

    page.emit('request', faviconRequest);
    page.emit('request', webSocketRequest);

    expect(monitor.pending.size).toBe(0);
    monitor.dispose();
  });

  it('url PDF final gate should wait for network again after media and DOM checks', async () => {
    const monitor = {
      pending: new Set(),
      failures: new Set(),
      lastActivityAt: Date.now(),
      logLabel: '[urlToPdf][page=1][name=report]',
      dispose: jest.fn(),
    };
    const networkSpy = jest
      .spyOn(service as any, 'waitForUrlPdfNetworkSettled')
      .mockResolvedValue(undefined);
    const mediaSpy = jest
      .spyOn(service as any, 'waitMediaLoaded')
      .mockResolvedValue(undefined);
    const domSpy = jest
      .spyOn(service as any, 'waitForUrlPdfDomStable')
      .mockResolvedValue(undefined);

    await (service as any).waitUrlPdfFinalReady({}, monitor, Date.now() + 1000);

    expect(networkSpy).toHaveBeenCalledTimes(3);
    expect(networkSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mediaSpy.mock.invocationCallOrder[0],
    );
    expect(mediaSpy.mock.invocationCallOrder[0]).toBeLessThan(
      networkSpy.mock.invocationCallOrder[1],
    );
    expect(domSpy.mock.invocationCallOrder[0]).toBeLessThan(
      networkSpy.mock.invocationCallOrder[2],
    );
  });

  it('visual render lock should serialize final page rendering', async () => {
    const executionOrder: string[] = [];
    let releaseFirstTask: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });

    const firstTask = (service as any).runWithUrlPdfVisualRenderLock(
      '[page=1]',
      async () => {
        executionOrder.push('first-start');
        markFirstStarted();
        await firstBarrier;
        executionOrder.push('first-end');
        return 1;
      },
    );
    await firstStarted;
    const secondTask = (service as any).runWithUrlPdfVisualRenderLock(
      '[page=2]',
      async () => {
        executionOrder.push('second-start');
        return 2;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executionOrder).toEqual(['first-start']);

    releaseFirstTask();
    await expect(Promise.all([firstTask, secondTask])).resolves.toEqual([1, 2]);
    expect(executionOrder).toEqual([
      'first-start',
      'first-end',
      'second-start',
    ]);
  });

  it('visual render lock should release the next page after a failure', async () => {
    const firstTask = (service as any).runWithUrlPdfVisualRenderLock(
      '[page=1]',
      async () => {
        throw new Error('visual failure');
      },
    );
    const secondTask = (service as any).runWithUrlPdfVisualRenderLock(
      '[page=2]',
      async () => 'second-complete',
    );

    await expect(firstTask).rejects.toThrow('visual failure');
    await expect(secondTask).resolves.toBe('second-complete');
  });

  it('waitForUrlPdfVisualSettled should bring the page forward before checking transitions', async () => {
    const page = {
      bringToFront: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue({
        transitionNodes: 0,
        finiteAnimations: 2,
        elapsedMs: 420,
        timedOut: false,
      }),
    };

    await expect(
      (service as any).waitForUrlPdfVisualSettled(
        page,
        Date.now() + 1000,
        '[page=1]',
      ),
    ).resolves.toBeUndefined();

    expect(page.bringToFront).toHaveBeenCalledTimes(1);
    expect(page.bringToFront.mock.invocationCallOrder[0]).toBeLessThan(
      page.evaluate.mock.invocationCallOrder[0],
    );
  });

  it('waitForUrlPdfVisualSettled should reject remaining transition nodes', async () => {
    const page = {
      bringToFront: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue({
        transitionNodes: 9,
        finiteAnimations: 0,
        elapsedMs: 3000,
        timedOut: true,
      }),
    };

    await expect(
      (service as any).waitForUrlPdfVisualSettled(
        page,
        Date.now() + 1000,
        '[page=1]',
      ),
    ).rejects.toThrow('仍有 9 个过渡节点');
  });

  it('renderUrlPdfItem should retry once with a fresh render attempt', async () => {
    const result = {
      name: '1.report.pdf',
      buffer: Buffer.from('pdf'),
      headers: { 'Content-Type': 'application/pdf' },
    };
    const renderOnceSpy = jest
      .spyOn(service as any, 'renderUrlPdfItemOnce')
      .mockRejectedValueOnce(new Error('resource timeout'))
      .mockResolvedValueOnce(result);

    await expect(
      (service as any).renderUrlPdfItem(
        { url: 'https://example.com', name: 'report', option: {} },
        0,
      ),
    ).resolves.toEqual(result);
    expect(renderOnceSpy).toHaveBeenCalledTimes(2);
  });

  it('renderUrlPdfItem should stop after the second failed attempt', async () => {
    const renderOnceSpy = jest
      .spyOn(service as any, 'renderUrlPdfItemOnce')
      .mockRejectedValue(new Error('resource timeout'));

    await expect(
      (service as any).renderUrlPdfItem(
        { url: 'https://example.com', name: 'report', option: {} },
        0,
      ),
    ).rejects.toThrow('resource timeout');
    expect(renderOnceSpy).toHaveBeenCalledTimes(2);
  });

  it('renderUrlPdfItem should not generate a PDF after readiness timeout', async () => {
    const pages = [0, 1].map(() => {
      return Object.assign(new EventEmitter(), {
        evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
        setViewport: jest.fn().mockResolvedValue(undefined),
        goto: jest.fn().mockResolvedValue(undefined),
        pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
        isClosed: jest.fn().mockReturnValue(false),
        close: jest.fn().mockResolvedValue(undefined),
      });
    });
    (service as any).browser = {
      newPage: jest
        .fn()
        .mockResolvedValueOnce(pages[0])
        .mockResolvedValueOnce(pages[1]),
    };
    jest
      .spyOn(service as any, 'waitUrlPdfPageReady')
      .mockRejectedValue(new Error('页面资源等待超时'));

    await expect(
      (service as any).renderUrlPdfItem(
        { url: 'https://example.com', name: 'report', option: {} },
        0,
      ),
    ).rejects.toThrow('页面资源等待超时');

    expect(pages[0].pdf).not.toHaveBeenCalled();
    expect(pages[1].pdf).not.toHaveBeenCalled();
    expect(pages[0].close).toHaveBeenCalledTimes(1);
    expect(pages[1].close).toHaveBeenCalledTimes(1);
  });

  it('url PDF logs should hide URLs and tokens from error messages', () => {
    const summary = (service as any).getUrlPdfSafeErrorSummary(
      new Error(
        'request failed: https://example.com/report?token=secret token=another-secret',
      ),
    );

    expect(summary).toContain('[URL已隐藏]');
    expect(summary).not.toContain('https://example.com');
    expect(summary).not.toContain('secret');
  });

  it('waitPageLoaded should log and continue when media wait throws', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
      waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service as any, 'getPageScrollState').mockResolvedValue({
      height: 1000,
      scrollTop: 1000,
      viewportHeight: 1000,
    });
    jest
      .spyOn(service as any, 'waitMediaLoaded')
      .mockRejectedValue(new Error('Execution context was destroyed'));
    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).waitPageLoaded(page, {
        scrollTimes: 1,
        minScrollTimes: 1,
        scrollDelay: 1,
        scrollOffset: 1000,
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'waitPageLoaded - media wait failed, continue PDF: Execution context was destroyed',
    );
  });
});
