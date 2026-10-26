type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_LEVEL === 'silent') return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message, stack: err.stack?.split('\n').slice(0, 6).join('\n') };
  }
  return { error: String(err) };
}
