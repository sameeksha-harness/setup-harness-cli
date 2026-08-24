import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import * as tc from '@actions/tool-cache';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

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

export function fetchLatestHcVersion(githubToken?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'setup-harness-cli',
      Accept: 'application/vnd.github+json',
    };
    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
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
    }).on('error', (e: Error) => reject(new Error(`GitHub API request failed: ${e.message}`)));
  });
}

export async function resolveHcVersion(requested: string, githubToken?: string): Promise<string> {
  const trimmed = requested.trim().toLowerCase();
  if (!trimmed || trimmed === 'latest') {
    core.info('Resolving latest hc version from GitHub...');
    const tag = await fetchLatestHcVersion(githubToken);
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

function mapPlatform(platform: string): string {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function mapArch(arch: string): string {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported architecture: ${arch}. Supported: x64, arm64`);
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
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
  const platform = mapPlatform(os.platform());
  const arch = mapArch(os.arch());
  const ver = version.replace(/^v/, '');
  const assetName = `hc_${ver}_${platform}_${arch}.tar.gz`;
  const baseUrl = `https://github.com/harness/harness-cli/releases/download/${version}`;

  core.info(`Downloading hc ${version} (${platform}/${arch})...`);

  // Download tarball and checksums concurrently
  const [tarPath, checksumsPath] = await Promise.all([
    tc.downloadTool(`${baseUrl}/${assetName}`),
    tc.downloadTool(`${baseUrl}/checksums.txt`),
  ]);

  // Verify SHA-256 before executing anything
  const checksums = fs.readFileSync(checksumsPath, 'utf8');
  const expectedLine = checksums.split('\n').find((l) => l.includes(assetName));
  if (!expectedLine) {
    throw new Error(`No checksum entry found for ${assetName} in checksums.txt`);
  }
  const expectedHash = expectedLine.trim().split(/\s+/)[0];
  const actualHash = await hashFile(tarPath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}`,
    );
  }
  core.info(`SHA-256 verified for ${assetName}`);

  // Extract and add to PATH
  await fs.promises.mkdir(installDir, { recursive: true });
  await tc.extractTar(tarPath, installDir);
  core.addPath(installDir);
}

/**
 * Ensures hc is installed and on PATH exactly once per job.
 * Uses SETUP_HC_VERSION as a job-scoped marker (set via core.exportVariable)
 * so repeated calls within the same job are instant no-ops.
 */
export async function ensureHc(requestedVersion = '', githubToken?: string): Promise<string> {
  const version = await resolveHcVersion(requestedVersion, githubToken);

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
