import { Logger } from '@nestjs/common';
import { cancelOnWorker } from './worker-cancel';

describe('cancelOnWorker', () => {
  let warn: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const answer = (status: number) => fetchSpy.mockResolvedValue(new Response('{}', { status }));

  it('sends DELETE /trials/<id> to WORKER_URL for each id', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    answer(200);
    const before = process.env.WORKER_URL;
    process.env.WORKER_URL = 'http://worker.test:9/';
    try {
      await cancelOnWorker(['a-1', 'b-2']);
    } finally {
      if (before === undefined) delete process.env.WORKER_URL;
      else process.env.WORKER_URL = before;
    }
    expect(fetchSpy.mock.calls.map((c) => [c[0], c[1].method])).toEqual([
      ['http://worker.test:9/trials/a-1', 'DELETE'],
      ['http://worker.test:9/trials/b-2', 'DELETE'],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([200, 404])('HTTP %i is the wanted outcome and is not logged', async (status) => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    answer(status);
    await expect(cancelOnWorker(['t1'])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([500, 503, 401, 409])('HTTP %i is logged as a warning and does not throw', async (status) => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    answer(status);
    await expect(cancelOnWorker(['t1'])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`HTTP ${status}`);
  });

  it('a network error is logged and does not throw, and the other ids are still sent', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(cancelOnWorker(['t1', 't2'])).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('fetch failed');
  });
});
