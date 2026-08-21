import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { login, AuthInputs, ExecFn, ExecOptions } from './auth';
import { ensureHc } from './install';

/**
 * Reads an action input; falls back to an environment variable if the input is empty.
 * Throws if both are absent and the value is required.
 */
function getInputOrEnv(inputName: string, envName: string, required = false): string {
  const fromInput = core.getInput(inputName);
  if (fromInput) return fromInput;
  const fromEnv = process.env[envName] ?? '';
  if (required && !fromEnv) {
    throw new Error(
      `Input "${inputName}" is required. Set it via the action input or the ${envName} environment variable.`,
    );
  }
  return fromEnv;
}

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
    const token = getInputOrEnv('token', 'HARNESS_PAT_TOKEN', true);
    core.setSecret(token);

    const hcVersion = core.getInput('hc-version');
    const installedVersion = await ensureHc(hcVersion);

    const inputs: AuthInputs = {
      apiUrl:  getInputOrEnv('api-url',  'HARNESS_URL',        true),
      account: getInputOrEnv('account',  'HARNESS_ACCOUNT_ID', true),
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
