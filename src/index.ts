import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { login, AuthInputs, ExecFn, ExecOptions } from './auth';
import { ensureHc, MARKER_HC_VERSION } from './install';

/** Env var used as a within-job marker so login runs only once per account per job. */
const MARKER_LOGGED_IN = 'SETUP_HC_LOGGED_IN';

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

async function verifyHcCommand(execFn: ExecFn): Promise<void> {
  const { exitCode, stdout } = await execFn('hc', ['version'], { silent: true });
  if (exitCode !== 0 || !stdout.includes('hc version')) {
    throw new Error('hc is not usable after setup — "hc version" failed. Check PATH and installation.');
  }
}

export async function run(): Promise<void> {
  try {
    const token = getInputOrEnv('token', 'HARNESS_PAT_TOKEN', true);
    core.setSecret(token);

    const githubToken = core.getInput('github-token');
    if (githubToken) core.setSecret(githubToken);

    const hcVersion = core.getInput('hc-version');
    const installedVersion = await ensureHc(hcVersion, githubToken);

    const inputs: AuthInputs = {
      apiUrl:   getInputOrEnv('api-url', 'HARNESS_URL',        true),
      account:  getInputOrEnv('account', 'HARNESS_ACCOUNT_ID', true),
      token,
      org:      getInputOrEnv('org',     'HARNESS_ORG_ID')     || undefined,
      project:  getInputOrEnv('project', 'HARNESS_PROJECT_ID') || undefined,
    };

    // Within-job login marker: skip auth if already logged in to the same server.
    // Marker includes api-url so switching servers triggers a fresh login.
    const loginMarkerValue = inputs.apiUrl;
    const loginMarker = process.env[MARKER_LOGGED_IN];
    if (loginMarker === loginMarkerValue) {
      core.info(`Already logged in at ${inputs.apiUrl}, skipping`);
    } else {
      core.startGroup('hc auth login');
      try {
        const redactedCmd = [
          `hc auth login --api-url ${inputs.apiUrl} --account ${inputs.account} --api-token ***`,
          inputs.org     ? `--org ${inputs.org}`         : '',
          inputs.project ? `--project ${inputs.project}` : '',
          '--non-interactive',
        ].filter(Boolean).join(' ');
        core.info(redactedCmd);
        await login(inputs, buildExecFn());
        core.exportVariable(MARKER_LOGGED_IN, loginMarkerValue);
      } finally {
        core.endGroup();
      }
    }

    // Verify hc is fully usable before reporting ready
    await verifyHcCommand(buildExecFn());

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

export { MARKER_HC_VERSION, MARKER_LOGGED_IN };
