import {NativeModules, Platform} from 'react-native';

// Collects a timestamped trace of the connection attempt so it can be
// saved to Downloads or emailed when something goes wrong.
const lines: string[] = [];
const start = Date.now();

const ts = () => {
  const d = new Date();
  return `${d.toISOString()} (+${((Date.now() - start) / 1000).toFixed(3)}s)`;
};

export function dlog(msg: string) {
  const line = `${ts()} ${msg}`;
  lines.push(line);
  if (lines.length > 500000) {
    lines.splice(0, lines.length - 500000);
  }
  console.log('[debug]', msg);
}

// Keep the first few frames and drop the long dev-server bundle URLs.
function shortStack(stack: string) {
  return stack
    .split('\n')
    .filter(l => !/at (construct|apply) \(native\)/.test(l))
    .slice(0, 6)
    .map(l => l.replace(/\(https?:\/\/[^)]*?:(\d+:\d+)\)/, '(bundle:$1)'))
    .join('\n');
}

export function dlogError(where: string, e: any) {
  dlog(
    `ERROR in ${where}: ${e?.message ?? e}` +
      (e?.errorCode != null ? ` | bleErrorCode=${e.errorCode}` : '') +
      (e?.reason ? ` | reason=${e.reason}` : '') +
      (e?.androidErrorCode != null ? ` | androidCode=${e.androidErrorCode}` : '') +
      (e?.attErrorCode != null ? ` | attCode=${e.attErrorCode}` : '') +
      (e?.stack ? `\n${shortStack(e.stack)}` : ''),
  );
}

// Show raw bytes both printable and in hex so odd adapter replies are visible.
export function fmtBytes(s: string) {
  const printable = s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const hexStr = Array.from(s, ch =>
    ch.charCodeAt(0).toString(16).padStart(2, '0'),
  ).join(' ');
  return `"${printable}" [${hexStr}]`;
}

export function resetLog() {
  lines.length = 0;
}

function buildReport() {
  const header = [
    '=== OBD-II Demo App – connection debug log ===',
    `Generated: ${new Date().toISOString()}`,
    `Platform: ${Platform.OS} ${Platform.Version}`,
    `Device: ${JSON.stringify((Platform as any).constants ?? {})}`,
    '',
  ];
  return header.concat(lines).join('\n');
}

const fileName = () =>
  `obd-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

const native = NativeModules.DebugLog as
  | {
      saveToDownloads(name: string, content: string): Promise<string>;
      share(name: string, content: string, subject: string): Promise<boolean>;
    }
  | undefined;

export async function saveDebugLog(): Promise<string> {
  if (!native) throw new Error('DebugLog native module not available');
  return native.saveToDownloads(fileName(), buildReport());
}

export async function shareDebugLog(): Promise<void> {
  if (!native) throw new Error('DebugLog native module not available');
  await native.share(
    fileName(),
    buildReport(),
    'OBD-II Demo App connection debug log',
  );
}
