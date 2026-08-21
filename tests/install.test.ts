export {};

const mockInfo = jest.fn();
const mockAddPath = jest.fn();
const mockExec = jest.fn();
const mockRestoreCache = jest.fn();
const mockSaveCache = jest.fn();

jest.mock('@actions/core', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  debug: (...args: unknown[]) => mockInfo(...args),
  addPath: (...args: unknown[]) => mockAddPath(...args),
}));

jest.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock('@actions/cache', () => ({
  restoreCache: (...args: unknown[]) => mockRestoreCache(...args),
  saveCache: (...args: unknown[]) => mockSaveCache(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: { mkdir: jest.fn().mockResolvedValue(undefined) },
}));

// Stub out the GitHub API call so tests don't hit the network
jest.mock('https', () => ({
  get: jest.fn(),
}));

const { normalizeHcVersion, versionsMatch, resolveHcVersion, ensureHc } =
  require('../src/install');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RUNNER_TEMP;
  mockRestoreCache.mockResolvedValue(undefined); // cache miss by default
  mockSaveCache.mockResolvedValue(0);
});

describe('normalizeHcVersion', () => {
  test('adds leading v when missing', () => {
    expect(normalizeHcVersion('1.3.43')).toBe('v1.3.43');
  });

  test('keeps leading v', () => {
    expect(normalizeHcVersion('v1.3.43')).toBe('v1.3.43');
  });

  test('rejects shell metacharacters', () => {
    expect(() => normalizeHcVersion('v1.3.43; rm -rf /')).toThrow(/Invalid hc-version/);
    expect(() => normalizeHcVersion('$(reboot)')).toThrow(/Invalid hc-version/);
  });
});

describe('versionsMatch', () => {
  test('matches hc version output without leading v', () => {
    expect(versionsMatch('hc version 1.3.43\nBuilt with go1.22\n', 'v1.3.43')).toBe(true);
  });

  test('matches when expected omits v', () => {
    expect(versionsMatch('hc version 1.3.43\n', '1.3.43')).toBe(true);
  });

  test('rejects mismatch', () => {
    expect(versionsMatch('hc version 1.2.0\n', 'v1.3.43')).toBe(false);
  });

  test('rejects unparseable output', () => {
    expect(versionsMatch('not a version', 'v1.3.43')).toBe(false);
  });
});

describe('resolveHcVersion', () => {
  test('returns normalized version when explicit tag given', async () => {
    await expect(resolveHcVersion('1.3.43')).resolves.toBe('v1.3.43');
  });

  test('fetches latest from GitHub when "latest" given', async () => {
    const https = require('https');
    https.get.mockImplementation((_opts: any, cb: any) => {
      const res = {
        on: (event: string, handler: any) => {
          if (event === 'data') handler(JSON.stringify({ tag_name: 'v2.0.0' }));
          if (event === 'end') handler();
          return res;
        },
      };
      cb(res);
      return { on: jest.fn() };
    });

    await expect(resolveHcVersion('latest')).resolves.toBe('v2.0.0');
  });

  test('fetches latest when empty string given', async () => {
    const https = require('https');
    https.get.mockImplementation((_opts: any, cb: any) => {
      const res = {
        on: (event: string, handler: any) => {
          if (event === 'data') handler(JSON.stringify({ tag_name: 'v2.0.0' }));
          if (event === 'end') handler();
          return res;
        },
      };
      cb(res);
      return { on: jest.fn() };
    });

    await expect(resolveHcVersion('')).resolves.toBe('v2.0.0');
  });
});

describe('ensureHc', () => {
  test('skips install when PATH hc matches requested version', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 0;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });

    const version = await ensureHc('v1.3.43');

    expect(version).toBe('v1.3.43');
    expect(mockExec.mock.calls.some((c: any[]) => c[0] === 'sh')).toBe(false);
    expect(mockRestoreCache).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('already on PATH'));
  });

  test('restores from cache when available (no download)', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    mockRestoreCache.mockResolvedValue('setup-hc-v1.3.43-linux-arm64');

    await ensureHc('v1.3.43');

    expect(mockExec.mock.calls.some((c: any[]) => c[0] === 'sh')).toBe(false);
    expect(mockAddPath).toHaveBeenCalled();
    expect(mockSaveCache).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Restored'));
  });

  test('installs and saves cache on cache miss', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'sh') return 0;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });

    await ensureHc('v1.3.43');

    expect(mockExec.mock.calls.some((c: any[]) => c[0] === 'sh')).toBe(true);
    expect(mockSaveCache).toHaveBeenCalled();
    expect(mockAddPath).toHaveBeenCalled();
  });

  test('fails if post-install version does not match', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'sh') return 0;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 9.9.9\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });

    await expect(ensureHc('v1.3.43')).rejects.toThrow(/version mismatch/);
  });

  test('continues if cache save fails', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'sh') return 0;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    mockSaveCache.mockRejectedValue(new Error('cache quota exceeded'));

    await expect(ensureHc('v1.3.43')).resolves.toBe('v1.3.43');
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Cache save skipped'));
  });
});
