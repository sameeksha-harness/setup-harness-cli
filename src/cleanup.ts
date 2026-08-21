import * as core from '@actions/core';
import * as exec from '@actions/exec';

export async function cleanup(): Promise<void> {
  try {
    core.info('Removing Harness CLI authentication...');
    const exitCode = await exec.exec('hc', ['auth', 'logout'], {
      ignoreReturnCode: true,
      silent: true,
    });
    if (exitCode !== 0) {
      core.info('hc auth logout returned non-zero; credentials may already be cleared');
    } else {
      core.info('Harness CLI credentials removed');
    }
  } catch (err) {
    // Non-fatal — runner will be recycled; just log and move on
    core.info(`Cleanup skipped: ${err}`);
  }
}

/* istanbul ignore next */
if (require.main === module) {
  cleanup();
}
