export interface AuthInputs {
  apiUrl: string;
  account: string;
  token: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  silent?: boolean;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.replace(
    new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    '***',
  );
}

export async function login(inputs: AuthInputs, execFn: ExecFn): Promise<void> {
  const { exitCode, stdout, stderr } = await execFn(
    'hc',
    [
      'auth', 'login',
      '--api-url', inputs.apiUrl,
      '--api-token', inputs.token,
      '--account', inputs.account,
      '--non-interactive',
    ],
    { silent: true },
  );

  if (exitCode !== 0) {
    const raw = [stdout, stderr].filter(Boolean).join('\n').slice(0, 2048);
    throw new Error(`hc auth login failed (exit ${exitCode}): ${redact(raw, inputs.token)}`);
  }
}
