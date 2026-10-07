// Build the EightForge evaluation image (Dockerfile.eval) from one commit.
//
//   node scripts/evaluation/docker/build-eval-image.mjs [<commit>]
//
// The build context is `git -c core.autocrlf=false archive <commit>`: the
// committed blob bytes, identical on Windows and Linux, and nothing untracked
// (no .env.local, no cached eng.traineddata, no local Docker artifacts).
// Uncommitted changes are never in the image; the script says so when the
// working tree is dirty. Runs on any host with node, git and docker.
//
// Optional: EIGHTFORGE_EVAL_BUILD_CA=<pem bundle> for a TLS-intercepting proxy
// (mounted as a build secret, never stored in the image).
import { spawn, spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const requested = process.argv[2] ?? 'HEAD';
const commit = run('git', ['rev-parse', '--verify', `${requested}^{commit}`]);
if (run('git', ['status', '--porcelain', '--untracked-files=no'])) {
  process.stderr.write(`note: the working tree has uncommitted changes; the image is built from ${commit} only\n`);
}
const nodeImage = process.env.EIGHTFORGE_EVAL_NODE_IMAGE;
// The canonical image is tagged :<commit12> and :local. A runtime-parity audit
// variant (another Node image) gets its own tag and never replaces :local.
const tag = nodeImage
  ? `eightforge-eval:${commit.slice(0, 12)}-${process.env.EIGHTFORGE_EVAL_NODE_TAG ?? 'node-variant'}`
  : `eightforge-eval:${commit.slice(0, 12)}`;
const args = ['build', '--file', 'Dockerfile.eval', '--build-arg', `SOURCE_COMMIT=${commit}`, '--tag', tag,
  ...(nodeImage ? ['--build-arg', `NODE_IMAGE=${nodeImage}`] : ['--tag', 'eightforge-eval:local'])];
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
  if (process.env[name]) args.push('--build-arg', name);
}
if (process.env.EIGHTFORGE_EVAL_BUILD_NETWORK) args.push('--network', process.env.EIGHTFORGE_EVAL_BUILD_NETWORK);
if (process.env.EIGHTFORGE_EVAL_BUILD_CA) args.push('--secret', `id=build_ca,src=${process.env.EIGHTFORGE_EVAL_BUILD_CA}`);
args.push('-');

const archive = spawn('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', commit], { stdio: ['ignore', 'pipe', 'inherit'] });
const build = spawn('docker', args, { stdio: ['pipe', 'inherit', 'inherit'] });
archive.stdout.pipe(build.stdin);
const [archiveCode, buildCode] = await Promise.all([
  new Promise((resolve) => archive.on('close', resolve)),
  new Promise((resolve) => build.on('close', resolve)),
]);
if (archiveCode !== 0 || buildCode !== 0) {
  process.stderr.write(`build failed (git archive ${archiveCode}, docker build ${buildCode})\n`);
  process.exit(1);
}
const imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
process.stdout.write(`\nbuilt ${tag}${nodeImage ? '' : ' (also eightforge-eval:local)'} from ${commit}\nEIGHTFORGE_EVAL_IMAGE_ID=${imageId}\n`);
