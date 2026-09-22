import { Platform } from '@bitdev/platforms.platform';

const TraderApp = import.meta.resolve('@minecraft7900/auto-trader.trader-app');
const TradingService = import.meta.resolve('@minecraft7900/auto-trader.trading-service');
const PlatformGateway = import.meta.resolve('@bitdev/platforms.backend.gateway-server');

/**
 * Composes the trading dashboard and the autonomous trading service into a
 * single deployable unit.
 */
export const TraderPlatform = Platform.from({
  name: 'trader-platform',

  frontends: {
    main: TraderApp,
    mainPortRange: [3000, 3100],
  },

  backends: {
    main: PlatformGateway,
    services: [TradingService],
  },
});

export default TraderPlatform;
