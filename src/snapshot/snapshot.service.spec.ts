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
});
