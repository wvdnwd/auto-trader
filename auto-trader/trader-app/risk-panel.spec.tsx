import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from './i18n.js';
import { RiskPanel } from './risk-panel.js';
import type { RiskConfig } from './types.js';

const risk: RiskConfig = {
  baseRiskPct: 0.01,
  maxRiskPct: 0.02,
  minLeverage: 1,
  maxLeverage: 10,
  maxOpenPositions: 5,
  maxTotalMarginPct: 0.5,
  maxDrawdownPct: 0.2,
  dailyLossLimitPct: 0.05,
  minConfidence: 0.4,
  maxPositionHours: 24,
  atrStopMultiple: 2,
  trailArmR: 1.5,
  trailGiveback: 0.5,
  firstTargetR: 1.5,
  firstTargetPortion: 0.4,
  finalTargetR: 3,
  breakEvenAfterFirst: true,
  requireHigherAlignment: true,
  maxSameSidePositions: 3,
  maxPerGroup: 2,
  highConvictionConfidence: 0.7,
  maxOverflowPositions: 1,
  chopPauseStreak: 6,
  trendFlipProtection: true,
  trendFlipTrimPortion: 0.5,
  pauseNewEntries: false,
  minStakePct: 0.05,
  targetStakePct: 0.2,
  minTradeMarginUsdt: 25,
  entryCooldownMinutes: 5,
  maxFundingRateLong: 0.0005,
};

function renderPanel(onSave: (patch: Partial<RiskConfig>) => Promise<void>) {
  return render(
    <LanguageProvider>
      <RiskPanel risk={risk} onSave={onSave} />
    </LanguageProvider>
  );
}

describe('RiskPanel', () => {
  it('saves only changed fields, not a stale pause value from an unrelated edit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderPanel(onSave);
    const maxPositions = document.getElementById('maxOpenPositions') as HTMLInputElement;
    fireEvent.change(maxPositions, { target: { value: '6' } });

    rerender(
      <LanguageProvider>
        <RiskPanel risk={{ ...risk, pauseNewEntries: true }} onSave={onSave} />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Risico-instellingen opslaan/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ maxOpenPositions: 6 });
  });

  it('shows a rejected save as an error rather than success', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('server refused update'));
    renderPanel(onSave);
    fireEvent.change(document.getElementById('maxOpenPositions') as HTMLInputElement, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Risico-instellingen opslaan/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('server refused update');
    expect(screen.queryByText(/Instellingen succesvol opgeslagen/)).toBeNull();
  });
});
