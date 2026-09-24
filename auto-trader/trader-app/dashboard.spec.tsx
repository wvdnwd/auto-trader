import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, fetchSnapshot, setApiToken } from './api.js';
import { Dashboard } from './dashboard.js';
import { LanguageProvider } from './i18n.js';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    fetchSnapshot: vi.fn(),
    setApiToken: vi.fn(),
  };
});

describe('Dashboard authentication prompt', () => {
  it('shows an actionable token input on 401 and retries with the tab token', async () => {
    vi.mocked(fetchSnapshot).mockRejectedValue(new ApiError('401: token required', 401));
    vi.mocked(setApiToken).mockReturnValue(true);
    render(
      <LanguageProvider>
        <Dashboard />
      </LanguageProvider>
    );

    const input = await screen.findByLabelText(/API-toegang vereist/);
    fireEvent.change(input, { target: { value: 'session-token' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => expect(setApiToken).toHaveBeenCalledWith('session-token'));
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(2));
  });
});
