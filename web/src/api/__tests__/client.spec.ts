import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorFromBody, setApiBase } from '../client';

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBase('/api');
});

const reply = (status: number, body: unknown, statusText = '') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText });

describe('errorFromBody', () => {
  it('keeps the adapter reasons of a refused config (POST /configs 400)', () => {
    const e = errorFromBody(
      400,
      'Bad Request',
      JSON.stringify({ message: 'config refused: the harness cannot honor these settings exactly', reasons: ['the minimal loop has no skills; skills.enabled must be false'] }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.message).toBe('config refused: the harness cannot honor these settings exactly');
    expect(e.reasons).toEqual(['the minimal loop has no skills; skills.enabled must be false']);
  });

  it('collects issues and problems, and joins an array message', () => {
    const issues = errorFromBody(400, '', JSON.stringify({ message: 'invalid experiment body', issues: ['n_trials: Required'] }));
    expect(issues.reasons).toEqual(['n_trials: Required']);
    const problems = errorFromBody(409, '', JSON.stringify({ message: 'cannot be reproduced', problems: ['p1', 'p2'] }));
    expect(problems.reasons).toEqual(['p1', 'p2']);
    const arr = errorFromBody(400, '', JSON.stringify({ message: ['a must be a string', 'b must be a number'], statusCode: 400 }));
    expect(arr.message).toBe('a must be a string; b must be a number');
    expect(arr.reasons).toEqual(['a must be a string', 'b must be a number']);
  });

  it('falls back to the response text, then the status text', () => {
    expect(errorFromBody(502, 'Bad Gateway', '<html>nginx 502</html>').message).toBe('<html>nginx 502</html>');
    expect(errorFromBody(500, 'Internal Server Error', '').message).toBe('Internal Server Error');
  });
});

describe('api', () => {
  it('throws an ApiError carrying the API body on a non-2xx answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404, { message: 'experiment x not found', statusCode: 404 })));
    await expect(api.getExperiment('x')).rejects.toMatchObject({ status: 404, message: 'experiment x not found' });
  });

  it('reports an unreachable API as status 0 with the base in the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.listConfigs()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('/api') });
  });

  it('createConfig says created for 201 and existing for 200', async () => {
    const config = { id: 'c1', name: 'n' };
    vi.stubGlobal('fetch', vi.fn(async () => reply(201, config)));
    expect((await api.createConfig({} as never)).created).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, config)));
    expect((await api.createConfig({} as never)).created).toBe(false);
  });

  it('builds paths from the current base and drops empty query values', async () => {
    const fetchMock = vi.fn(async () => reply(200, []));
    vi.stubGlobal('fetch', fetchMock);
    setApiBase('http://localhost:3000/');
    await api.listTrials('E1', { status: 'done', config_id: '' });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/experiments/E1/trials?status=done', undefined);
    expect(api.compareCsvUrl('E1', 'a1', 'b1')).toBe('http://localhost:3000/experiments/E1/compare.csv?a=a1&b=b1');
    expect(api.exportCsvUrl('E1')).toBe('http://localhost:3000/experiments/E1/export.csv');
  });

  it('posts JSON with a content type', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => reply(200, { id: 'E1' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.extendExperiment('E1', 5);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"n_trials":5}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
});
