import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { login, AuthInputs, ExecFn, ExecOptions } from './auth';
import { ensureHc } from './install';

function buildExecFn(): ExecFn {
  return async (cmd: string, args: string[], options: ExecOptions = {}) => {
    let stdout = '';
    let stderr = '';
    const exitCode = await exec.exec(cmd, args, {
      ignoreReturnCode: true,
      silent: options.silent === true,
      listeners: {
        stdout: (data: Buffer) => { stdout += data.toString(); },
        stderr: (data: Buffer) => { stderr += data.toString(); },
      },
    });
    return { exitCode, stdout, stderr };
  };
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput('token', { required: true });
    core.setSecret(token);

    const hcVersion = core.getInput('hc-version');
    const installedVersion = await ensureHc(hcVersion);

    const inputs: AuthInputs = {
      apiUrl:  core.getInput('api-url',  { required: true }),
      account: core.getInput('account',  { required: true }),
      token,
    };

    core.startGroup('hc auth login');
    try {
      core.info(
        `hc auth login --api-url ${inputs.apiUrl} --api-token *** --account ${inputs.account} --non-interactive`,
      );
      await login(inputs, buildExecFn());
    } finally {
      core.endGroup();
    }

    core.setOutput('hc-version', installedVersion);
    core.info(`Harness CLI (hc) ${installedVersion} is ready`);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/* istanbul ignore next */
if (require.main === module) {
  run();
}
