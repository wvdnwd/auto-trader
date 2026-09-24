import { fetchSnapshot, setApiToken } from './api.js';

describe('authenticated API client', () => {
  afterEach(() => {
    setApiToken('');
    vi.unstubAllGlobals();
  });

  it('sends a tab-scoped Bearer token without tenant headers or cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    setApiToken('session-token');

    await fetchSnapshot();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer session-token');
    expect(headers.has('x-client-id')).toBe(false);
    expect(init.credentials).toBe('omit');
    expect(url).not.toContain('session-token');
    expect(init.body).toBeUndefined();
  });
});
