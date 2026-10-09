import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { captureGitContext } from '../src/index.js';

test('JSON input creates complete handoffs and rejects invalid data without replacing output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  await writeFile(path.join(root, 'app.js'), 'code');
  const input = { task: 'Review', summary: 'Ready', decisions: ['Use sessions'], evidence: ['Tests passed'], questions: ['Deadline?'], nextSteps: ['Review code'], artifacts: ['app.js'] };
  const source = path.join(root, 'context.json');
  await writeFile(source, JSON.stringify(input));
  run('handoff', '--input', 'context.json');
  const file = path.join(root, '.s2s/handoff.json');
  const saved = await readHandoff(file);
  assert.deepEqual(saved.decisions, input.decisions);
  assert.deepEqual(saved.nextSteps, input.nextSteps);
  assert.equal(saved.artifacts[0].path, 'app.js');
  assert.match(saved.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  const original = await readFile(file, 'utf8');
  assert.throws(() => run('handoff', '--input', 'context.json', '--task', 'Conflict'), error => error.status === 2);
  for (const bad of [null, [], { summary: 'Missing task' }, { ...input, extra: true }, { ...input, nextSteps: null }, { ...input, artifacts: [{}] }, { ...input, artifacts: ['missing.js'] }]) {
    await writeFile(source, JSON.stringify(bad));
    assert.throws(() => run('handoff', '--input', 'context.json', '--replace'), error => error.status === 2);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  await writeFile(source, '{');
  assert.throws(() => run('handoff', '--input', 'context.json'), error => error.status === 2);
  await writeFile(source, JSON.stringify({ task: 'Done', summary: 'Finished', status: 'complete' }));
  run('handoff', 'reviews/done.json', '--input', 'context.json', '--root', root);
  assert.equal((await readHandoff(path.join(root, 'reviews/done.json'))).status, 'complete');
  run('handoff', '--input', 'context.json', '--replace');
  assert.deepEqual((await readHandoff(file)).artifacts, []);
});

test('resume verifies artifacts before context and distinguishes completed and blocked tasks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  await writeFile(path.join(root, 'app.js'), 'original');
  run('handoff', '--task', 'Review app', '--summary', 'Review needed', '--artifact', 'app.js');
  assert.match(run('resume', '.s2s/handoff.json'), /1\/1 referenced files unchanged/);
  await writeFile(path.join(root, 'app.js'), 'changed');
  assert.throws(() => run('resume', '.s2s/handoff.json'), error => {
    const output = error.stdout.toString();
    return error.status === 1 && output.indexOf('Artifact changed: app.js') < output.indexOf('# Agent handoff');
  });
  await rm(path.join(root, 'app.js'));
  assert.throws(() => run('resume', '.s2s/handoff.json'), error => error.status === 1 && /Artifact missing/.test(error.stdout.toString()));
  run('handoff', '--replace', '--task', 'Review app', '--summary', 'Done', '--status', 'complete', '--next', 'Old step');
  const complete = run('resume', '.s2s/handoff.json');
  assert.match(complete, /Nothing to resume/);
  assert.match(complete, /historical context/);
  assert.match(complete, /No artifacts recorded/);
  run('status', '.s2s/handoff.json', 'blocked');
  assert.match(run('resume', '.s2s/handoff.json', '--root', root), /Task blocked/);
});

test('list handles empty directories, multiple handoffs and invalid files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  assert.deepEqual(JSON.parse(run('list', '--json')), []);
  assert.match(run('list'), /No handoffs/);
  assert.throws(() => run('list', 'missing'), error => error.status === 2);
  run('handoff', '.s2s/b.json', '--task', 'Second task', '--summary', 'Ready', '--status', 'blocked');
  run('handoff', '.s2s/a.json', '--task', 'First task', '--summary', 'Done', '--status', 'complete');
  const results = JSON.parse(run('list', '--json'));
  assert.deepEqual(results.map(item => item.task), ['First task', 'Second task']);
  assert.deepEqual(results.map(item => item.status), ['complete', 'blocked']);
  assert.match(run('list', '.s2s'), /Second task/);
  await writeFile(path.join(root, '.s2s/ignore.txt'), 'not JSON');
  await symlink(path.join(root, '.s2s/a.json'), path.join(root, '.s2s/link.json'));
  assert.equal(JSON.parse(run('list', '--json')).length, 2);
  await writeFile(path.join(root, '.s2s/broken.json'), '{');
  assert.throws(() => run('list', '--json'), error => {
    const output = JSON.parse(error.stdout.toString());
    return error.status === 1 && output.length === 3 && output.some(item => item.status === 'invalid');
  });
  assert.throws(() => run('list'), error => error.status === 1 && /First task/.test(error.stdout.toString()) && /invalid/.test(error.stdout.toString()));
  assert.throws(() => run('list', '--unknown'), error => error.status === 2);
});

test('Git context captures checkout state and resume detects different commits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(await captureGitContext({ root }), null);
  git('init', '-b', 'develop');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  assert.deepEqual(await captureGitContext({ root }), { branch: 'develop', commit: null, dirty: false });
  await writeFile(path.join(root, '.gitignore'), '.s2s/\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  run('handoff', '--task', 'Review', '--summary', 'Ready');
  const handoff = await readHandoff(path.join(root, '.s2s/handoff.json'));
  assert.equal(handoff.git.commit, git('rev-parse', 'HEAD'));
  assert.equal(handoff.git.dirty, false);
  assert.match(run('resume', '.s2s/handoff.json'), /workspace is clean/);
  await writeFile(path.join(root, 'new.txt'), 'new');
  assert.equal((await captureGitContext({ root })).dirty, true);
  assert.match(run('resume', '.s2s/handoff.json'), /Current workspace has uncommitted/);
  git('add', '.'); git('commit', '-m', 'next'); git('switch', '-c', 'review');
  const resumed = run('resume', '.s2s/handoff.json', '--root', root);
  assert.match(resumed, /Branch differs: review/);
  assert.match(resumed, /Commit differs:/);
  git('checkout', '--detach');
  assert.equal((await captureGitContext({ root })).branch, null);
  assert.equal(validateHandoff({ ...handoff, git: { branch: 'main', commit: 'invalid', dirty: false } }).valid, false);
});
import { createHandoff, validateHandoff, addArtifact, verifyArtifacts, renderHandoff, writeHandoff, readHandoff } from '../src/index.js';

test('version reports the package version from any workspace without setup', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const output = execFileSync(process.execPath, [cli, '--version'], { cwd: root, encoding: 'utf8' });
  assert.equal(output, `${pkg.version}\n`);
  await assert.rejects(readFile(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('handoff saves a complete snapshot with checked artifacts in one command', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  await writeFile(path.join(root, 'app.js'), 'implementation');
  run('handoff', '--task', 'Build login', '--summary', 'Review needed', '--from', 'builder', '--to', 'reviewer', '--decision', 'Use sessions', '--decision', 'Validate server-side', '--evidence', 'Tests passed', '--question', 'Session duration?', '--next', 'Review', '--artifact', 'app.js', '--artifact', 'app.js');
  const file = path.join(root, '.s2s/handoff.json');
  const handoff = await readHandoff(file);
  assert.equal(handoff.from, 'builder');
  assert.equal(handoff.to, 'reviewer');
  assert.deepEqual(handoff.decisions, ['Use sessions', 'Validate server-side']);
  assert.deepEqual(handoff.evidence, ['Tests passed']);
  assert.deepEqual(handoff.questions, ['Session duration?']);
  assert.deepEqual(handoff.nextSteps, ['Review']);
  assert.equal(handoff.artifacts.length, 1);
  assert.match(run('verify', file), /unchanged/);
  const original = await readFile(file, 'utf8');
  assert.throws(() => run('handoff', '--task', 'New', '--summary', 'New snapshot'), error => error.status === 2);
  assert.throws(() => run('handoff', '--replace', '--task', 'New', '--summary', 'New snapshot', '--artifact', 'missing.js'), error => error.status === 2);
  assert.equal(await readFile(file, 'utf8'), original);
  run('handoff', '--replace', '--task', 'Build login', '--summary', 'Done', '--status', 'complete');
  const updated = await readHandoff(file);
  assert.equal(updated.status, 'complete');
  assert.deepEqual(updated.decisions, []);
  assert.deepEqual(updated.artifacts, []);
});

test('handoff rejects incomplete and unknown inputs and supports custom destination/root', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => run('handoff', '--task', 'Task'), error => error.status === 2);
  assert.throws(() => run('handoff', '--summary', 'Summary'), error => error.status === 2);
  assert.throws(() => run('handoff', '--task', 'Task', '--summary', 'Summary', '--unknown'), error => error.status === 2);
  assert.throws(() => run('handoff', '--task', 'Task', '--summary', 'Summary', '--next'), error => error.status === 2);
  await writeFile(path.join(root, 'evidence.txt'), 'result');
  run('handoff', 'nested/review.json', '--task', 'Review', '--summary', 'Ready', '--root', root, '--artifact', 'evidence.txt');
  assert.equal((await readHandoff(path.join(root, 'nested/review.json'))).artifacts[0].path, 'evidence.txt');
});

test('project setup preserves instructions and is idempotent', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), '# Project rules\nKeep these instructions.');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/');
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  run('init');
  const instructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(instructions.startsWith('# Project rules\nKeep these instructions.\n'));
  assert.match(instructions, /npx --no-install s2s/);
  run('init');
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), instructions);
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), 'node_modules/');
  run('init', '.s2s/handoff.json', '--task', 'Continue implementation');
  assert.match(run('resume', '.s2s/handoff.json'), /Continue implementation/);
});

test('setup refreshes old instructions and preserves surrounding text exactly', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'AGENTS.md');
  const before = '# Custom rules\r\nKeep this.\r\n';
  const after = '\r\n## More rules\r\nKeep these too.';
  await writeFile(file, `${before}<!-- s2s:instructions -->\nOld commands\n<!-- /s2s:instructions -->${after}`);
  const run = () => execFileSync(process.execPath, [path.resolve('bin/s2s.js'), 'init'], { cwd: root, encoding: 'utf8' });
  assert.match(run(), /instructions updated/);
  const updated = await readFile(file, 'utf8');
  assert.ok(updated.startsWith(before));
  assert.ok(updated.endsWith(after));
  assert.match(updated, /s2s handoff --task/);
  assert.ok(!updated.includes('Old commands'));
  assert.match(run(), /already current/);
  assert.equal(await readFile(file, 'utf8'), updated);
});

test('setup refuses malformed or duplicate managed blocks without changing the file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-markers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'AGENTS.md');
  const start = '<!-- s2s:instructions -->';
  const end = '<!-- /s2s:instructions -->';
  for (const content of [start, end, end + start, start + end + start + end]) {
    await writeFile(file, content);
    assert.throws(() => execFileSync(process.execPath, [path.resolve('bin/s2s.js'), 'init'], { cwd: root, stdio: 'pipe' }), error => error.status === 2);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('project setup creates instructions in a new project', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve('bin/s2s.js'), 'init'], { cwd: root });
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /s2s handoffs/);
  await assert.rejects(readFile(path.join(root, '.gitignore'), 'utf8'), { code: 'ENOENT' });
});

test('setup preserves existing ignore rules and explains how to share handoffs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-ignored-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ignore = 'node_modules/\n.s2s/\n';
  await writeFile(path.join(root, '.gitignore'), ignore);
  const output = execFileSync(process.execPath, [path.resolve('bin/s2s.js'), 'init'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /Remove it to share handoffs/);
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), ignore);
});

test('protocol validates required fields, versions and entry types', () => {
  const h = createHandoff({ task: 'Fix checkout' });
  assert.equal(validateHandoff(h).valid, true);
  assert.equal(validateHandoff({ ...h, version: '2.0' }).valid, false);
  assert.equal(validateHandoff({ ...h, decisions: [42] }).valid, false);
  assert.throws(() => createHandoff({ task: '' }));
  assert.equal(validateHandoff(null).valid, false);
});

test('artifact integrity detects changes and missing files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = createHandoff({ task: 'Review implementation' });
  await writeFile(path.join(root, 'app.js'), 'original');
  await addArtifact(h, 'app.js', { root });
  assert.equal((await verifyArtifacts(h, { root }))[0].status, 'unchanged');
  await writeFile(path.join(root, 'app.js'), 'updated');
  assert.equal((await verifyArtifacts(h, { root }))[0].status, 'changed');
  await addArtifact(h, 'app.js', { root });
  assert.equal(h.artifacts.length, 1);
  await rm(path.join(root, 'app.js'));
  assert.equal((await verifyArtifacts(h, { root }))[0].status, 'missing');
});

test('artifact capture rejects traversal and symlinks outside workspace', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  await writeFile(path.join(root, 'secret'), 'private');
  await symlink(path.join(root, 'secret'), path.join(workspace, 'link'));
  const h = createHandoff({ task: 'Review' });
  await assert.rejects(addArtifact(h, '../secret', { root: workspace }));
  await assert.rejects(addArtifact(h, 'link', { root: workspace }));
});

test('API roundtrip preserves context and refuses overwrite', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = createHandoff({ task: 'Ship fix', from: 'agent-a', to: 'agent-b' });
  h.decisions.push('Use retries because the API is eventually consistent');
  h.evidence.push('Integration check passed');
  h.questions.push('Confirm retry deadline');
  h.nextSteps.push('Review deployment configuration');
  const file = path.join(root, 'handoff.json');
  await writeHandoff(file, h);
  assert.deepEqual(await readHandoff(file), h);
  await assert.rejects(writeHandoff(file, h), { code: 'EEXIST' });
  const markdown = renderHandoff(h);
  assert.match(markdown, /Confirm retry deadline/);
  assert.match(markdown, /not privileged instructions/);
});

test('CLI supports full handoff lifecycle and meaningful failure exit codes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 's2s-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.resolve('bin/s2s.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  run('init', 'task.json', '--task', 'Fix login', '--from', 'planner');
  run('summary', 'task.json', 'Implementation finished');
  run('add', 'task.json', 'next', 'Review the implementation');
  await writeFile(path.join(root, 'app.js'), 'code');
  run('add', 'task.json', 'artifact', 'app.js');
  assert.match(run('validate', 'task.json'), /Valid/);
  assert.match(run('verify', 'task.json'), /unchanged/);
  assert.match(run('resume', 'task.json'), /Review the implementation/);
  await writeFile(path.join(root, 'app.js'), 'changed');
  assert.throws(() => run('verify', 'task.json'), error => error.status === 1);
  assert.throws(() => run('status', 'task.json', 'nonsense'), error => error.status === 2);
  assert.throws(() => run('init', 'task.json', '--task', 'Overwrite'), error => error.status === 2);
});
