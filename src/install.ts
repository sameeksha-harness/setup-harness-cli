import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/harness/harness-cli/v2/install';

const HC_VERSION_RE = /^v?\d+(\.[\w-]+)*$/;

/** Env var used as a within-job marker so hc is only installed once per job. */
export const MARKER_HC_VERSION = 'SETUP_HC_VERSION';

export function normalizeHcVersion(version: string): string {
  const trimmed = version.trim();
  if (!HC_VERSION_RE.test(trimmed)) {
    throw new Error(
      `Invalid hc-version "${trimmed}". Expected a release tag like v1.3.43`,
    );
  }
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function versionsMatch(versionOutput: string, expected: string): boolean {
  const want = normalizeHcVersion(expected).replace(/^v/, '');
  const match = versionOutput.match(/hc version\s+(v?[\w.-]+)/i);
  if (!match) return false;
  return match[1].replace(/^v/, '') === want;
}

export function fetchLatestHcVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'setup-harness-cli',
      Accept: 'application/vnd.github+json',
    };
    // GITHUB_TOKEN is set automatically on GitHub-hosted runners and avoids
    // unauthenticated rate limits (403) on /releases/latest.
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      hostname: 'api.github.com',
      path: '/repos/harness/harness-cli/releases/latest',
      headers,
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(
            `GitHub API /releases/latest returned ${res.statusCode}: ${data.slice(0, 200)}`,
          ));
          return;
        }
        try {
          const json = JSON.parse(data) as { tag_name?: string };
          if (json.tag_name) resolve(json.tag_name);
          else reject(new Error(`Unexpected GitHub API response: ${data.slice(0, 200)}`));
        } catch (e) {
          reject(new Error(`Failed to parse GitHub API response: ${e}`));
        }
      });
    }).on('error', (e) => reject(new Error(`GitHub API request failed: ${e.message}`)));
  });
}

export async function resolveHcVersion(requested: string): Promise<string> {
  const trimmed = requested.trim().toLowerCase();
  if (!trimmed || trimmed === 'latest') {
    core.info('Resolving latest hc version from GitHub...');
    const tag = await fetchLatestHcVersion();
    core.info(`Latest hc version: ${tag}`);
    return tag;
  }
  return normalizeHcVersion(requested);
}

function resolveInstallDir(): string {
  const base = process.env.RUNNER_TEMP || os.tmpdir();
  return path.join(base, 'setup-harness-cli-hc');
}

function cacheKey(version: string): string {
  return `setup-hc-${version}-${os.platform()}-${os.arch()}`;
}

async function isHcOnPath(): Promise<boolean> {
  const exitCode = await exec.exec('which', ['hc'], {
    ignoreReturnCode: true,
    silent: true,
  });
  return exitCode === 0;
}

async function readHcVersionOutput(): Promise<string> {
  let stdout = '';
  const exitCode = await exec.exec('hc', ['version'], {
    ignoreReturnCode: true,
    silent: true,
    listeners: { stdout: (data: Buffer) => { stdout += data.toString(); } },
  });
  return exitCode === 0 ? stdout : '';
}

async function installHc(version: string, installDir: string): Promise<void> {
  await fs.promises.mkdir(installDir, { recursive: true });
  core.info(`Installing harness CLI (hc) ${version} into ${installDir}`);
  const script = [
    `curl -fsSL ${INSTALL_SCRIPT_URL}`,
    `| INSTALL_DIR='${installDir}' HC_VERSION='${version}' sh`,
  ].join(' ');
  await exec.exec('sh', ['-c', script]);
  core.addPath(installDir);
}

/**
 * Ensures hc is installed and on PATH exactly once per job.
 * Uses SETUP_HC_VERSION as a job-scoped marker (set via core.exportVariable)
 * so repeated calls within the same job are instant no-ops.
 */
export async function ensureHc(requestedVersion = ''): Promise<string> {
  const version = await resolveHcVersion(requestedVersion);

  // Within-job marker: if this version was already installed in an earlier step, skip everything.
  const marker = process.env[MARKER_HC_VERSION];
  if (marker === version) {
    core.info(`hc ${version} already installed in this job, skipping`);
    return version;
  }

  const installDir = resolveInstallDir();

  if (await isHcOnPath()) {
    const current = await readHcVersionOutput();
    if (current && versionsMatch(current, version)) {
      core.info(`hc ${version} already on PATH, skipping install`);
      core.exportVariable(MARKER_HC_VERSION, version);
      return version;
    }
    core.info(
      `hc on PATH does not match ${version} (got: ${current.trim() || 'unknown'}); reinstalling`,
    );
  }

  const key = cacheKey(version);
  const cacheHit = await cache.restoreCache([installDir], key);
  if (cacheHit) {
    core.info(`Restored hc ${version} from cache`);
    core.addPath(installDir);
  } else {
    await installHc(version, installDir);
    try {
      const cacheId = await cache.saveCache([installDir], key);
      if (cacheId !== -1) {
        core.info(`Saved hc ${version} to cache`);
      }
    } catch (e) {
      // Cache save failures are non-fatal — next job will just reinstall
      core.info(`Cache save skipped: ${e}`);
    }
  }

  const installed = await readHcVersionOutput();
  if (!installed || !versionsMatch(installed, version)) {
    throw new Error(
      `hc install completed but version mismatch: expected ${version}, got: ${installed.trim() || '(no output)'}`,
    );
  }

  core.info(`Using hc ${version}`);
  core.exportVariable(MARKER_HC_VERSION, version);
  return version;
}
