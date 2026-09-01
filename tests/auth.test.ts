export {};

import { login, AuthInputs, ExecFn } from '../src/auth';

const INPUTS: AuthInputs = {
  apiUrl:  'https://app.harness.io',
  account: 'acc-123',
  token:   'pat.acc-123.secret',
};

function makeExecFn(exitCode: number, stdout = '', stderr = ''): ExecFn {
  return jest.fn().mockResolvedValue({ exitCode, stdout, stderr });
}

describe('login', () => {
  test('calls hc auth login with correct args and silent:true', async () => {
    const execFn = makeExecFn(0);
    await login(INPUTS, execFn);

    expect(execFn).toHaveBeenCalledWith(
      'hc',
      ['auth', 'login', '--api-url', 'https://app.harness.io', '--account', 'acc-123', '--api-token', 'pat.acc-123.secret', '--non-interactive'],
      { silent: true },
    );
  });

  test('includes --org and --project when provided', async () => {
    const execFn = makeExecFn(0);
    await login({ ...INPUTS, org: 'my-org', project: 'my-project' }, execFn);

    expect(execFn).toHaveBeenCalledWith(
      'hc',
      ['auth', 'login', '--api-url', 'https://app.harness.io', '--account', 'acc-123', '--api-token', 'pat.acc-123.secret', '--non-interactive', '--org', 'my-org', '--project', 'my-project'],
      { silent: true },
    );
  });

  test('omits --org and --project when not provided', async () => {
    const execFn = makeExecFn(0);
    await login(INPUTS, execFn);

    const args = (execFn as jest.Mock).mock.calls[0][1] as string[];
    expect(args).not.toContain('--org');
    expect(args).not.toContain('--project');
  });

  test('resolves on exit code 0', async () => {
    await expect(login(INPUTS, makeExecFn(0))).resolves.toBeUndefined();
  });

  test('throws on non-zero exit code', async () => {
    const execFn = makeExecFn(1, 'auth failed', '');
    await expect(login(INPUTS, execFn)).rejects.toThrow(/hc auth login failed/);
  });

  test('redacts token from error message', async () => {
    const execFn = makeExecFn(1, 'bad token pat.acc-123.secret rejected', '');
    await expect(login(INPUTS, execFn)).rejects.toThrow(/\*\*\*/);
    await expect(login(INPUTS, execFn)).rejects.not.toThrow(/pat\.acc-123\.secret/);
  });
});
