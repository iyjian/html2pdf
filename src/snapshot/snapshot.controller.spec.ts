import { EventEmitter } from 'events';
import { SnapshotController } from './snapshot.controller';

interface FakeResponse {
  handlers: Record<string, () => void>;
  destroyed: boolean;
  writableEnded: boolean;
  on: jest.Mock;
  set: jest.Mock;
  send: jest.Mock;
  status: jest.Mock;
}

const createResponse = (): FakeResponse => {
  const handlers: Record<string, () => void> = {};
  const res: any = {
    handlers,
    destroyed: false,
    writableEnded: false,
    on: jest.fn((event: string, handler: () => void) => {
      handlers[event] = handler;
    }),
    set: jest.fn(),
    send: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);

  return res;
};

const createRequest = () => {
  const socket = new EventEmitter();

  return { socket, aborted: false };
};

describe('SnapshotController urlToPaf', () => {
  const config = [{ url: 'https://example.com', name: 'report', option: {} }];

  it('should send the generated file and pass an abort signal', async () => {
    const res = createResponse();
    const req = createRequest();
    const urlToPdf = jest.fn().mockResolvedValue({
      name: 'download.zip',
      buffer: Buffer.from('zip'),
      headers: { 'Content-Type': 'application/zip' },
    });
    const controller = new SnapshotController({ urlToPdf } as any);

    await controller.urlToPaf(config, 'download', req as any, res as any);

    expect(urlToPdf).toHaveBeenCalledWith(
      config,
      'download',
      expect.any(AbortSignal),
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('zip'));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should abort the render and skip the response when the client disconnects', async () => {
    const res = createResponse();
    const req = createRequest();
    const urlToPdf = jest.fn(async () => {
      // 客户端关闭页面 => 连接关闭，且响应尚未结束。
      res.handlers.close();
      throw new Error('客户端已断开，已停止生成 PDF');
    });
    const controller = new SnapshotController({ urlToPdf } as any);
    jest
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await controller.urlToPaf(config, 'download', req as any, res as any);

    const abortSignal = (
      urlToPdf.mock.calls[0] as unknown as any[]
    )[2] as AbortSignal;
    expect(abortSignal.aborted).toBe(true);
    expect(res.send).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should abort when only the underlying socket closes', async () => {
    const res = createResponse();
    const req = createRequest();
    const urlToPdf = jest.fn(async () => {
      // 代理只断开底层连接、不触发 res close 的情况。
      req.socket.emit('close');
      throw new Error('客户端已断开，已停止生成 PDF');
    });
    const controller = new SnapshotController({ urlToPdf } as any);
    const warnSpy = jest
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await controller.urlToPaf(config, 'download', req as any, res as any);

    const abortSignal = (
      urlToPdf.mock.calls[0] as unknown as any[]
    )[2] as AbortSignal;
    expect(abortSignal.aborted).toBe(true);
    expect(res.send).not.toHaveBeenCalled();
    // 日志里能看到触发来源，便于排查到底是哪条事件生效。
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('source=socket-close'),
    );
  });

  it('should abort immediately when the connection was already gone', async () => {
    const res = createResponse();
    res.destroyed = true;
    const req = createRequest();
    const urlToPdf = jest.fn().mockResolvedValue({
      name: 'download.zip',
      buffer: Buffer.from('zip'),
      headers: { 'Content-Type': 'application/zip' },
    });
    const controller = new SnapshotController({ urlToPdf } as any);
    jest
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await controller.urlToPaf(config, 'download', req as any, res as any);

    const abortSignal = (
      urlToPdf.mock.calls[0] as unknown as any[]
    )[2] as AbortSignal;
    expect(abortSignal.aborted).toBe(true);
  });

  it('should not abort when the connection closes after the response finished', async () => {
    const res = createResponse();
    const req = createRequest();
    const error = new Error('页面资源等待超时');
    const urlToPdf = jest.fn(async () => {
      res.writableEnded = true;
      res.handlers.close();
      throw error;
    });
    const controller = new SnapshotController({ urlToPdf } as any);
    const warnSpy = jest
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await controller.urlToPaf(config, 'download', req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(error);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
