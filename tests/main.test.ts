export {};

import * as crypto from 'crypto';

const mockGetInput = jest.fn();
const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockSetSecret = jest.fn();
const mockInfo = jest.fn();
const mockStartGroup = jest.fn();
const mockEndGroup = jest.fn();
const mockAddPath = jest.fn();
const mockExportVariable = jest.fn();

jest.mock('@actions/core', () => ({
  getInput:        mockGetInput,
  setOutput:       mockSetOutput,
  setFailed:       mockSetFailed,
  setSecret:       mockSetSecret,
  info:            mockInfo,
  startGroup:      mockStartGroup,
  endGroup:        mockEndGroup,
  addPath:         mockAddPath,
  exportVariable:  mockExportVariable,
}));

const mockExec = jest.fn();
jest.mock('@actions/exec', () => ({
  exec: mockExec,
}));

jest.mock('@actions/cache', () => ({
  restoreCache: jest.fn().mockResolvedValue(undefined),
  saveCache:    jest.fn().mockResolvedValue(0),
}));

jest.mock('@actions/tool-cache', () => ({
  downloadTool: jest.fn().mockResolvedValue('/tmp/mock-download'),
  extractTar:   jest.fn().mockResolvedValue('/tmp/mock-extract'),
}));

const mockReadFileSync = jest.fn();
const mockCreateReadStream = jest.fn();

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises:         { mkdir: jest.fn().mockResolvedValue(undefined) },
  readFileSync:     (...args: unknown[]) => mockReadFileSync(...args),
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
}));

jest.mock('https', () => ({ get: jest.fn() }));

// Pin platform/arch so asset names are deterministic across dev and CI
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  platform: () => 'linux',
  arch:     () => 'x64',
  tmpdir:   () => '/tmp',
}));

// Pre-compute a consistent mock binary hash for checksum tests
const MOCK_BINARY = Buffer.from('mock hc binary content');
const MOCK_HASH = crypto.createHash('sha256').update(MOCK_BINARY).digest('hex');
const MOCK_CHECKSUMS_143 = `${MOCK_HASH}  hc_1.3.43_linux_x86_64.tar.gz\n`;

function mockHashableStream() {
  const stream = {
    on(event: string, handler: any) {
      if (event === 'data') setImmediate(() => handler(MOCK_BINARY));
      if (event === 'end') setImmediate(() => handler());
      return stream; // chainable: .on(...).on(...).on(...)
    },
  };
  mockCreateReadStream.mockReturnValue(stream);
}

async function runModule(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/index');
  await mod.run();
}

const INPUTS: Record<string, string> = {
  'api-url':      'https://app.harness.io',
  'account':      'acc-123',
  'token':        'pat.acc-123.secret',
  'hc-version':   'v1.3.43',
  'github-token': '',
};

function setupInputMock(overrides: Record<string, string> = {}) {
  const merged = { ...INPUTS, ...overrides };
  mockGetInput.mockImplementation((name: string) => merged[name] ?? '');
}

/**
 * Happy-path exec mock for orchestration tests.
 * Install is skipped via SETUP_HC_VERSION marker, so only hc auth and hc version run.
 */
function mockExecHappyPath(versionOutput = 'hc version 1.3.43\n') {
  mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
    if (cmd === 'hc' && args[0] === 'version') {
      opts?.listeners?.stdout?.(Buffer.from(versionOutput));
      return 0;
    }
    if (cmd === 'hc' && args[0] === 'auth') return 0;
    return 0;
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  delete process.env.SETUP_HC_VERSION;
  delete process.env.SETUP_HC_LOGGED_IN;
  // Skip install by default in orchestration tests; install.test.ts covers installHc thoroughly
  process.env.SETUP_HC_VERSION = 'v1.3.43';
  // Reset cache mock after resetModules
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  test('sets install and login markers after first run', async () => {
    // Clear the marker so the full install path runs
    delete process.env.SETUP_HC_VERSION;
    setupInputMock();
    mockReadFileSync.mockReturnValue(MOCK_CHECKSUMS_143);
    mockHashableStream();
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      if (cmd === 'hc' && args[0] === 'auth') return 0;
      return 0;
    });

    await runModule();

    expect(mockExportVariable).toHaveBeenCalledWith('SETUP_HC_VERSION', 'v1.3.43');
    expect(mockExportVariable).toHaveBeenCalledWith('SETUP_HC_LOGGED_IN', 'acc-123@https://app.harness.io');
  });

  test('skips install when SETUP_HC_VERSION marker is set', async () => {
    // marker already set by beforeEach
    setupInputMock();
    mockExecHappyPath();

    await runModule();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('already installed in this job'));
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('skips login when SETUP_HC_LOGGED_IN marker matches account + api-url', async () => {
    setupInputMock();
    process.env.SETUP_HC_LOGGED_IN = 'acc-123@https://app.harness.io';
    mockExecHappyPath();

    await runModule();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Already logged in'));
    expect(mockStartGroup).not.toHaveBeenCalled();
  });

  test('does not skip login when same account but different api-url', async () => {
    setupInputMock({ 'api-url': 'https://staging.harness.io' });
    // marker was set for prod, but now we're talking to staging
    process.env.SETUP_HC_LOGGED_IN = 'acc-123@https://app.harness.io';
    mockExecHappyPath();

    await runModule();

    expect(mockStartGroup).toHaveBeenCalledWith('hc auth login');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('verifies hc is usable after setup (health check)', async () => {
    setupInputMock();
    mockExecHappyPath();

    await runModule();

    // hc version must be called as part of health check
    const versionCalls = mockExec.mock.calls.filter(
      (c: any[]) => c[0] === 'hc' && c[1][0] === 'version',
    );
    expect(versionCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('fails if hc is not usable after setup', async () => {
    setupInputMock();
    process.env.SETUP_HC_LOGGED_IN = 'acc-123@https://app.harness.io';
    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'hc' && args[0] === 'version') return 1; // health check fails
      return 0;
    });

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('hc is not usable after setup'),
    );
  });

  test('masks token before any exec call', async () => {
    setupInputMock();
    const callOrder: string[] = [];
    mockSetSecret.mockImplementation(() => { callOrder.push('setSecret'); });
    mockExec.mockImplementation(async (cmd: string, _args: string[], opts: any) => {
      callOrder.push(cmd);
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

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('HARNESS_PAT_TOKEN'),
    );
  });

  test('resolves latest version when hc-version is "latest"', async () => {
    setupInputMock({ 'hc-version': 'latest' });
    // After resolving latest → v2.0.0, the marker must match to skip install
    process.env.SETUP_HC_VERSION = 'v2.0.0';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    mockExecHappyPath('hc version 2.0.0\n');

    await runModule();

    expect(mockSetOutput).toHaveBeenCalledWith('hc-version', 'v2.0.0');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('downloads, verifies and extracts when no marker or cache', async () => {
    delete process.env.SETUP_HC_VERSION;
    setupInputMock();
    mockReadFileSync.mockReturnValue(MOCK_CHECKSUMS_143);
    mockHashableStream();
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      if (cmd === 'hc' && args[0] === 'auth') return 0;
      return 0;
    });

    await runModule();

    expect(mockSetOutput).toHaveBeenCalledWith('hc-version', 'v1.3.43');
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('SHA-256 verified'));
  });
});
