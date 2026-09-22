/**
 * Best-effort outbound alerting for important engine events.
 *
 * Configured via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (a free Telegram bot),
 * or a generic `NOTIFY_WEBHOOK_URL` that receives a JSON POST — pick whichever is
 * set. Both are optional: when neither is configured this module is a silent
 * no-op so paper trading works unmodified. Delivery failures are logged to the
 * console only — a notification going missing must never interrupt the trading
 * loop or fail a scan cycle.
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL;

/** Network timeout for an outbound notification, in milliseconds. */
const TIMEOUT_MS = 5000;

/**
 * Whether at least one notification channel has been configured.
 *
 * @returns true when a Telegram bot or a generic webhook is set up.
 */
export function hasNotificationChannel(): boolean {
  return Boolean((TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) || WEBHOOK_URL);
}

/**
 * The kinds of events worth interrupting the user for.
 *
 * Routine scan info is intentionally excluded — only fills, exits and risk
 * halts are worth a push notification.
 */
export type NotificationKind = 'trade-open' | 'trade-close' | 'risk-halt' | 'engine-error';

/** One outbound alert. */
export type NotificationEvent = {
  kind: NotificationKind;
  message: string;
};

async function postJson(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const KIND_EMOJI: Record<NotificationKind, string> = {
  'trade-open': '📈',
  'trade-close': '📉',
  'risk-halt': '🛑',
  'engine-error': '⚠️',
};

/**
 * Send a notification through every configured channel. Never throws — a
 * failed delivery is logged and swallowed so it cannot break the caller.
 *
 * @param event the notification to deliver.
 */
export async function notify(event: NotificationEvent): Promise<void> {
  if (!hasNotificationChannel()) return;
  const text = `${KIND_EMOJI[event.kind]} ${event.message}`;

  const jobs: Promise<void>[] = [];

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    jobs.push(
      postJson(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      })
    );
  }

  if (WEBHOOK_URL) {
    jobs.push(postJson(WEBHOOK_URL, { ...event, text }));
  }

  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.warn('[notifier] versturen mislukt:', result.reason);
    }
  }
}
