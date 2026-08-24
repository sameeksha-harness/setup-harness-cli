export {};

const mockGetInput = jest.fn();
const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockSetSecret = jest.fn();
const mockInfo = jest.fn();
const mockStartGroup = jest.fn();
const mockEndGroup = jest.fn();
const mockAddPath = jest.fn();

jest.mock('@actions/core', () => ({
  getInput:    mockGetInput,
  setOutput:   mockSetOutput,
  setFailed:   mockSetFailed,
  setSecret:   mockSetSecret,
  info:        mockInfo,
  startGroup:  mockStartGroup,
  endGroup:    mockEndGroup,
  addPath:     mockAddPath,
}));

const mockExec = jest.fn();
jest.mock('@actions/exec', () => ({
  exec: mockExec,
}));

jest.mock('@actions/cache', () => ({
  restoreCache: jest.fn().mockResolvedValue(undefined),
  saveCache:    jest.fn().mockResolvedValue(0),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: { mkdir: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('https', () => ({ get: jest.fn() }));

async function runModule(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../src/index');
  await mod.run();
}

const INPUTS: Record<string, string> = {
  'api-url':    'https://app.harness.io',
  'account':    'acc-123',
  'token':      'pat.acc-123.secret',
  'hc-version': 'v1.3.43',
};

function setupInputMock(overrides: Record<string, string> = {}) {
  const merged = { ...INPUTS, ...overrides };
  mockGetInput.mockImplementation((name: string) => merged[name] ?? '');
}

function mockExecHappyPath() {
  mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
    if (cmd === 'which') return 1;
    if (cmd === 'sh') return 0;
    if (cmd === 'hc' && args[0] === 'version') {
      opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
      return 0;
    }
    if (cmd === 'hc' && args[0] === 'auth') return 0;
    return 0;
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Reset cache mock after resetModules
  const cacheMock = require('@actions/cache');
  cacheMock.restoreCache = jest.fn().mockResolvedValue(undefined);
  cacheMock.saveCache    = jest.fn().mockResolvedValue(0);
});

describe('main orchestration', () => {
  test('installs hc, logs in, sets hc-version output', async () => {
    setupInputMock();
    mockExecHappyPath();

    await runModule();

    const authCall = mockExec.mock.calls.find(
      (c: any[]) => c[0] === 'hc' && c[1][0] === 'auth',
    );
    expect(authCall[1]).toEqual([
      'auth', 'login',
      '--api-url', 'https://app.harness.io',
      '--api-token', 'pat.acc-123.secret',
      '--account', 'acc-123',
      '--non-interactive',
    ]);
    expect(authCall[2]).toEqual(expect.objectContaining({ silent: true }));
    expect(mockSetOutput).toHaveBeenCalledWith('hc-version', 'v1.3.43');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('masks token before any exec call', async () => {
    setupInputMock();
    const callOrder: string[] = [];
    mockSetSecret.mockImplementation(() => { callOrder.push('setSecret'); });
    mockExec.mockImplementation(async (cmd: string, _args: string[], opts: any) => {
      callOrder.push(cmd);
      if (cmd === 'which') return 1;
      if (cmd === 'sh') return 0;
      if (cmd === 'hc') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      return 0;
    });

    await runModule();

    expect(callOrder[0]).toBe('setSecret');
    expect(mockSetSecret).toHaveBeenCalledWith('pat.acc-123.secret');
  });

  test('logs redacted login command (no real token)', async () => {
    setupInputMock();
    mockExecHappyPath();

    await runModule();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('--api-token ***'));
    expect(mockInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('pat.acc-123.secret'),
    );
  });

  test('login failure calls setFailed and closes group', async () => {
    setupInputMock();
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'sh') return 0;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      if (cmd === 'hc' && args[0] === 'auth') {
        opts?.listeners?.stdout?.(Buffer.from('authentication failed 401'));
        return 1;
      }
      return 0;
    });

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('hc auth login failed'),
    );
    expect(mockEndGroup).toHaveBeenCalled();
  });

  test('uses env vars when action inputs are empty', async () => {
    // Credential inputs empty — credentials come from env vars; hc-version still set
    mockGetInput.mockImplementation((name: string) =>
      name === 'hc-version' ? 'v1.3.43' : '',
    );
    process.env.HARNESS_URL        = 'https://env.harness.io';
    process.env.HARNESS_ACCOUNT_ID = 'env-account';
    process.env.HARNESS_PAT_TOKEN  = 'pat.env.token';
    mockExecHappyPath();

    await runModule();

    delete process.env.HARNESS_URL;
    delete process.env.HARNESS_ACCOUNT_ID;
    delete process.env.HARNESS_PAT_TOKEN;

    expect(mockSetSecret).toHaveBeenCalledWith('pat.env.token');
    const authCall = mockExec.mock.calls.find(
      (c: any[]) => c[0] === 'hc' && c[1][0] === 'auth',
    );
    expect(authCall[1]).toContain('https://env.harness.io');
    expect(authCall[1]).toContain('env-account');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('input takes precedence over env var', async () => {
    setupInputMock();
    process.env.HARNESS_PAT_TOKEN = 'pat.from.env';
    mockExecHappyPath();

    await runModule();

    delete process.env.HARNESS_PAT_TOKEN;

    expect(mockSetSecret).toHaveBeenCalledWith('pat.acc-123.secret');
  });

  test('fails when neither input nor env var provides token', async () => {
    mockGetInput.mockReturnValue('');
    delete process.env.HARNESS_PAT_TOKEN;
    mockExecHappyPath();

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('HARNESS_PAT_TOKEN'),
    );
  });

  test('resolves latest version when hc-version is "latest"', async () => {
    setupInputMock({ 'hc-version': 'latest' });
    const https = require('https');
    https.get.mockImplementation((_opts: any, cb: any) => {
      const res = {
        statusCode: 200,
        on: (event: string, handler: any) => {
          if (event === 'data') handler(JSON.stringify({ tag_name: 'v2.0.0' }));
          if (event === 'end') handler();
          return res;
        },
      };
      cb(res);
      return { on: jest.fn() };
    });
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'sh') return 0;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 2.0.0\n'));
        return 0;
      }
      if (cmd === 'hc' && args[0] === 'auth') return 0;
      return 0;
    });

    await runModule();

    expect(mockSetOutput).toHaveBeenCalledWith('hc-version', 'v2.0.0');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
