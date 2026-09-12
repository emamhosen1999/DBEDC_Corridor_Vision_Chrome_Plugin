/**
 * Local channels: console, Windows desktop toast, and the dashboard's live stream.
 */
import { execFile } from 'node:child_process';
import { log } from '../../core/logger.mjs';
import { ChannelError } from './http.mjs';

const logger = log('alert');

export const consoleChannel = {
  name: 'console',
  describe: () => 'Service log (always available)',
  validate: () => [],
  async send(msg) {
    const level = msg.severity === 'critical' ? 'error' : msg.severity === 'warning' ? 'warn' : 'info';
    logger[level](msg.title, { type: msg.alertType });
    return { target: 'log' };
  },
};

/**
 * Windows toast notification via WinRT, invoked through PowerShell.
 *
 * No BurntToast module or other install required — this uses the notification API
 * that ships with Windows 10 and 11.
 *
 * One honest limitation, because it changes how you should deploy: a service running
 * as SYSTEM lives in session 0 and CANNOT draw a toast in a logged-in user's session.
 * If desktop toasts matter to you, either run Corridor Vision as a scheduled task in
 * the operator's own session, or rely on the dashboard's browser notifications, which
 * always work because the browser IS in the user session. The remote channels
 * (WhatsApp, Telegram, email) are unaffected either way and remain the primary alert
 * path — which is the right design regardless.
 */
export const desktop = {
  name: 'desktop',
  describe: () => 'Windows desktop toast (user session only — not available to a SYSTEM service)',
  validate: () => (process.platform === 'win32' ? [] : ['desktop toasts are only implemented on Windows; this host is ' + process.platform]),

  async send(msg) {
    if (process.platform !== 'win32') {
      throw new ChannelError(`desktop toasts are not supported on ${process.platform}`, { permanent: true });
    }
    const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const bodyLines = msg.text.split('\n').filter(Boolean).slice(1, 5).join('\n');
    // `scenario="urgent"` keeps a critical toast on screen instead of auto-dismissing
    // after a few seconds — the old extension's alerts vanished unseen (finding M6).
    const scenario = msg.severity === 'critical' ? ' scenario="urgent"' : '';
    const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@"
<toast${scenario}><visual><binding template="ToastGeneric">
<text>${xmlEscape(msg.title)}</text>
<text>${xmlEscape(bodyLines)}</text>
</binding></visual><audio src="ms-winsoundevent:Notification.${msg.severity === 'critical' ? 'Looping.Alarm2' : 'Default'}"/></toast>
"@)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Corridor Vision").Show($toast)
`;
    await new Promise((resolve, reject) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 15_000, windowsHide: true },
        (err, _stdout, stderr) => {
          if (err) reject(new ChannelError(`toast failed: ${stderr || err.message}`, { permanent: false }));
          else resolve();
        });
    });
    return { target: 'desktop' };
  },
};

/**
 * Dashboard channel — pushes the alert to every open dashboard over SSE, where the
 * page raises a browser notification. This is the desktop notification path that
 * works regardless of how the service is installed.
 */
export function createDashboardChannel(broadcast) {
  return {
    name: 'dashboard',
    describe: () => 'Live dashboard (SSE push + browser notification)',
    validate: () => [],
    async send(msg) {
      broadcast('alert', {
        severity: msg.severity, type: msg.alertType, title: msg.title, text: msg.text, at: Date.now(),
      });
      return { target: 'dashboard' };
    },
  };
}
