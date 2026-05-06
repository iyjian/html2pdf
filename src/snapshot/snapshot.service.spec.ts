import { Test, TestingModule } from '@nestjs/testing';
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
