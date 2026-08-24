export {};

import * as crypto from 'crypto';

const mockInfo = jest.fn();
const mockAddPath = jest.fn();
const mockExportVariable = jest.fn();
const mockExec = jest.fn();
const mockRestoreCache = jest.fn();
const mockSaveCache = jest.fn();
const mockDownloadTool = jest.fn();
const mockExtractTar = jest.fn();
const mockReadFileSync = jest.fn();
const mockCreateReadStream = jest.fn();

jest.mock('@actions/core', () => ({
  info:           (...args: unknown[]) => mockInfo(...args),
  debug:          (...args: unknown[]) => mockInfo(...args),
  addPath:        (...args: unknown[]) => mockAddPath(...args),
  exportVariable: (...args: unknown[]) => mockExportVariable(...args),
}));

jest.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock('@actions/cache', () => ({
  restoreCache: (...args: unknown[]) => mockRestoreCache(...args),
  saveCache:    (...args: unknown[]) => mockSaveCache(...args),
}));

jest.mock('@actions/tool-cache', () => ({
  downloadTool: (...args: unknown[]) => mockDownloadTool(...args),
  extractTar:   (...args: unknown[]) => mockExtractTar(...args),
}));

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

const { normalizeHcVersion, versionsMatch, resolveHcVersion, ensureHc } =
  require('../src/install');

// Pre-compute a consistent mock binary hash for checksum tests
const MOCK_BINARY = Buffer.from('mock hc binary content');
const MOCK_HASH = crypto.createHash('sha256').update(MOCK_BINARY).digest('hex');

/** Makes createReadStream emit MOCK_BINARY so hashFile() returns MOCK_HASH. */
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

function mockGithubLatest(statusCode: number, body: string) {
  const https = require('https');
  https.get.mockImplementation((_opts: any, cb: any) => {
    const res = {
      statusCode,
      on: (event: string, handler: any) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
        return res;
      },
    };
    cb(res);
    return { on: jest.fn() };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RUNNER_TEMP;
  delete process.env.SETUP_HC_VERSION;
  mockRestoreCache.mockResolvedValue(undefined);
  mockSaveCache.mockResolvedValue(0);
  mockDownloadTool.mockResolvedValue('/tmp/mock-download');
  mockExtractTar.mockResolvedValue('/tmp/mock-extract');
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
    mockGithubLatest(200, JSON.stringify({ tag_name: 'v2.0.0' }));
    await expect(resolveHcVersion('latest')).resolves.toBe('v2.0.0');
  });

  test('fetches latest when empty string given', async () => {
    mockGithubLatest(200, JSON.stringify({ tag_name: 'v2.0.0' }));
    await expect(resolveHcVersion('')).resolves.toBe('v2.0.0');
  });

  test('passes github-token as Bearer when provided', async () => {
    const https = require('https');
    mockGithubLatest(200, JSON.stringify({ tag_name: 'v2.0.0' }));

    await resolveHcVersion('latest', 'ghs_test_token');

    expect(https.get).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ghs_test_token' }),
      }),
      expect.any(Function),
    );
  });

  test('fails clearly on non-200 GitHub API responses', async () => {
    mockGithubLatest(403, '{"message":"API rate limit exceeded"}');
    await expect(resolveHcVersion('latest')).rejects.toThrow(
      /GitHub API \/releases\/latest returned 403/,
    );
  });
});

describe('ensureHc', () => {
  test('skips install when SETUP_HC_VERSION marker matches', async () => {
    process.env.SETUP_HC_VERSION = 'v1.3.43';

    const version = await ensureHc('v1.3.43');

    expect(version).toBe('v1.3.43');
    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('already installed in this job'));
  });

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
    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('already on PATH'));
    expect(mockExportVariable).toHaveBeenCalledWith('SETUP_HC_VERSION', 'v1.3.43');
  });

  test('restores from cache — no download', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    mockRestoreCache.mockResolvedValue('setup-hc-v1.3.43-linux-x64');

    await ensureHc('v1.3.43');

    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockAddPath).toHaveBeenCalled();
    expect(mockSaveCache).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Restored'));
  });

  test('downloads, verifies SHA-256, extracts on cache miss', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    // checksums.txt contains the hash of our mock binary
    mockReadFileSync.mockReturnValue(`${MOCK_HASH}  hc_1.3.43_linux_x86_64.tar.gz\n`);
    mockHashableStream();

    await ensureHc('v1.3.43');

    expect(mockDownloadTool).toHaveBeenCalledTimes(2); // tarball + checksums
    expect(mockDownloadTool).toHaveBeenCalledWith(
      expect.stringContaining('hc_1.3.43_linux_x86_64.tar.gz'),
    );
    expect(mockDownloadTool).toHaveBeenCalledWith(
      expect.stringContaining('checksums.txt'),
    );
    expect(mockExtractTar).toHaveBeenCalled();
    expect(mockSaveCache).toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('SHA-256 verified'));
  });

  test('rejects tampered binary (SHA-256 mismatch)', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      return 0;
    });
    // checksums.txt has a different hash than what the binary produces
    mockReadFileSync.mockReturnValue(`deadbeef00000000000000000000000000000000000000000000000000000000  hc_1.3.43_linux_x86_64.tar.gz\n`);
    mockHashableStream();

    await expect(ensureHc('v1.3.43')).rejects.toThrow(/SHA-256 mismatch/);
  });

  test('fails if post-install version does not match', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 9.9.9\n'));
        return 0;
      }
      return 0;
    });
    mockReadFileSync.mockReturnValue(`${MOCK_HASH}  hc_1.3.43_linux_x86_64.tar.gz\n`);
    mockHashableStream();

    await expect(ensureHc('v1.3.43')).rejects.toThrow(/version mismatch/);
  });

  test('continues if cache save fails', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      if (cmd === 'which') return 1;
      if (cmd === 'hc' && args[0] === 'version') {
        opts?.listeners?.stdout?.(Buffer.from('hc version 1.3.43\n'));
        return 0;
      }
      return 0;
    });
    mockReadFileSync.mockReturnValue(`${MOCK_HASH}  hc_1.3.43_linux_x86_64.tar.gz\n`);
    mockHashableStream();
    mockSaveCache.mockRejectedValue(new Error('cache quota exceeded'));

    await expect(ensureHc('v1.3.43')).resolves.toBe('v1.3.43');
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Cache save skipped'));
  });
});
