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
      ['auth', 'login', '--api-url', 'https://app.harness.io', '--api-token', 'pat.acc-123.secret', '--account', 'acc-123', '--non-interactive'],
      { silent: true },
    );
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
