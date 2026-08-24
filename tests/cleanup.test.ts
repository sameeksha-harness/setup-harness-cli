export {};

const mockInfo = jest.fn();
const mockExec = jest.fn();

jest.mock('@actions/core', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
}));

jest.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanup } = require('../src/cleanup');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cleanup', () => {
  test('runs hc auth logout and logs success', async () => {
    mockExec.mockResolvedValue(0);
    await cleanup();
    expect(mockExec).toHaveBeenCalledWith(
      'hc', ['auth', 'logout'],
      expect.objectContaining({ ignoreReturnCode: true, silent: true }),
    );
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('removed'));
  });

  test('logs non-fatal message when logout returns non-zero', async () => {
    mockExec.mockResolvedValue(1);
    await cleanup();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('non-zero'));
  });

  test('does not throw when hc is not on PATH', async () => {
    mockExec.mockRejectedValue(new Error('hc: command not found'));
    await expect(cleanup()).resolves.toBeUndefined();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Cleanup skipped'));
  });
});
