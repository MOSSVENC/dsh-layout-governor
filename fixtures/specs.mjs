/**
 * Fixture specifications.
 *
 * Each entry describes the tree, the policy and the registry for one fixture;
 * `buildFixture` turns a spec into files on disk. Specs live in their own module
 * so no file here grows past a few hundred lines.
 */

/**
 * Deterministic pseudo-random bytes (LCG), so fixtures are reproducible and
 * cheap. Content identity is what matters, not randomness.
 *
 * @param {number} seed
 * @param {number} size
 * @returns {Buffer}
 */
export function blob(seed, size) {
  const buffer = Buffer.alloc(size);
  let state = (seed >>> 0) || 1;
  for (let i = 0; i < size; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[i] = state & 0xff;
  }
  return buffer;
}

/**
 * The policy every fixture starts from: every rule enabled, small thresholds.
 *
 * @returns {object} Policy document.
 */
export function basePolicy() {
  return {
    version: 1,
    ignore: ['**/node_modules/**', '**/.git/**'],
    classification: {
      regenerable: ['**/.venv/**', '**/node_modules/**', '**/iso_tree/**', '**/_scratch/**'],
      protected: [],
    },
    rules: {
      'top-level': { enabled: true, severity: 'fail', allow: [], allowPatterns: [], ignore: [] },
      backups: {
        enabled: true,
        severity: 'fail',
        allowedRoots: ['_archive'],
        allowedNamePattern: '^[0-9]{8}_[a-z0-9_-]+$',
        forbidNames: ['_backup', '_rescue_*', '*.bak.*', '*.bak', 'backup_*'],
        legacySymlinks: 'warn',
      },
      duplicates: { enabled: true, severity: 'fail', minBytes: 1024, maxCopies: 1, ignore: [] },
      families: {
        enabled: true,
        severity: 'warn',
        groups: [{ match: '**/*.iso', maxPer: 2, groupBy: 'dir' }],
      },
      'large-files': {
        enabled: true,
        severity: 'fail',
        minBytes: 1000000000,
        registry: 'layout.registry.yml',
      },
      docs: { enabled: true, severity: 'fail', file: 'README.md', ignore: [] },
      protected: { enabled: true, severity: 'warn', patterns: [] },
    },
  };
}

/**
 * Build a README that claims exactly the fixture's top-level directories.
 *
 * Keeps the docs rule quiet by construction, so a negative fixture can only fail
 * on the rule under test.
 *
 * @param {{ files?: Array<{ rel: string }> }} built Fixture tree description.
 * @returns {string} Markdown.
 */
export function autoReadme(built) {
  const tops = new Set();
  for (const entry of built.files ?? []) {
    const first = entry.rel.split('/')[0];
    if (entry.rel.includes('/')) tops.add(first);
  }
  const lines = ['# Fixture workspace', '', '## Top level', ''];
  for (const name of [...tops].sort()) lines.push(`- \`${name}/\` — fixture directory`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Merge per-fixture rule overrides over `basePolicy()`.
 *
 * @param {{ rules?: object, classification?: object, ignore?: string[] }} overrides
 * @returns {object} Policy document.
 */
export function policyWith(overrides) {
  const policy = basePolicy();
  for (const [ruleId, block] of Object.entries(overrides.rules ?? {})) {
    policy.rules[ruleId] = { ...policy.rules[ruleId], ...block };
  }
  if (overrides.classification) {
    policy.classification = { ...policy.classification, ...overrides.classification };
  }
  if (overrides.ignore) policy.ignore = overrides.ignore;
  return policy;
}

export const PROTECTED_PATTERNS = [
  'writings/writer/**',
  '**/U218*',
  '**/7705047215923976320*',
  '_context/dsbot_archive_20261117/**',
];

export const SPECS = {
  clean(root, base) {
    const readme = [
      '# Clean fixture workspace',
      '',
      '## Top level',
      '',
      '- `writings/` — writing line',
      '- `mining/` — mining line',
      '- `video/` — capture line',
      '- `game/` — game line',
      '- `wool/` — wool line',
      '- `_projects/` — standalone projects',
      '- `_tools/` — third-party tools',
      '- `_context/` — rules and context',
      '- `_archive/` — the only backup home',
      '',
      'Everything here is declared, deduplicated and registered.',
      '',
    ].join('\n');

    return {
      readme,
      files: [
        { rel: 'HANDOFF.md', content: Buffer.from('# Handoff\n'), day: 1 },
        { rel: 'writings/writer/books/daiqianshi/ch01.md', content: Buffer.from('chapter one\n'), day: 2 },
        { rel: 'writings/filter/xinghe/raw/U218_delisted.mp4', content: blob(101, 600), day: 3 },
        { rel: 'mining/worker/cs2-gpupv/vm/win11.vhdx', content: blob(102, 700), day: 4 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win11_stock.iso', content: blob(103, 800), day: 5 },
        { rel: 'video/capture/xinghe/raw/7705047215923976320.mp4', content: blob(104, 500), day: 6 },
        { rel: 'game/dev/plastic-world/project.godot', content: Buffer.from('config_version=5\n'), day: 7 },
        { rel: 'wool/harvest/readme.md', content: Buffer.from('# wool\n'), day: 8 },
        { rel: '_projects/cs2-vision/.venv/pyvenv.cfg', content: Buffer.from('home = /usr/bin\n'), day: 9 },
        { rel: '_tools/py312/python.exe', content: blob(105, 100), day: 10 },
        { rel: '_context/dsbot_archive_20261117/rules.md', content: Buffer.from('# rules\n'), day: 11 },
        { rel: '_archive/20261101_bootstrap/notes.md', content: Buffer.from('# bootstrap\n'), day: 12 },
      ],
      policy: policyWith({
        rules: {
          'top-level': {
            allow: [
              'writings',
              'mining',
              'video',
              'game',
              'wool',
              '_projects',
              '_tools',
              '_context',
              '_archive',
              'README.md',
              'HANDOFF.md',
            ],
          },
          protected: { patterns: PROTECTED_PATTERNS },
        },
        classification: { protected: PROTECTED_PATTERNS },
      }),
    };
  },

  duplicates() {
    return {
      files: [
        { rel: 'writings/a/install.wim', content: blob(7, 4096), day: 20 },
        { rel: 'mining/b/install.wim', content: blob(7, 4096), day: 5 },
        { rel: '_projects/c/install.wim', content: blob(7, 4096), day: 8 },
      ],
      policy: policyWith({
        rules: { 'top-level': { allow: ['writings', 'mining', '_projects', 'README.md'] } },
      }),
    };
  },

  'duplicates-protected'() {
    return {
      files: [
        { rel: 'writings/writer/books/master.md', content: blob(41, 2048), day: 1 },
        { rel: 'writings/hold/copy.md', content: blob(41, 2048), day: 5 },
        { rel: '_projects/mirror/master.md', content: blob(41, 2048), day: 6 },
      ],
      policy: policyWith({
        rules: {
          'top-level': { allow: ['writings', '_projects', 'README.md'] },
          protected: { patterns: ['writings/writer/**'] },
        },
        classification: { protected: ['writings/writer/**'] },
      }),
    };
  },

  'backup-location'() {
    return {
      files: [
        { rel: 'writings/_backup/x.tar.gz', content: blob(11, 300), day: 3 },
        { rel: 'writings/chapter.md', content: Buffer.from('text\n'), day: 4 },
        { rel: 'mining/worker/love.bak/notes.md', content: Buffer.from('old copy\n'), day: 5 },
        { rel: 'mining/worker/love/notes.md', content: Buffer.from('current\n'), day: 6 },
      ],
      policy: policyWith({
        rules: { 'top-level': { allow: ['writings', 'mining', 'README.md'] } },
      }),
    };
  },

  'docs-drift'() {
    return {
      readme: '# Drifted map\n\n## Top level\n\n- `quill/` — writing\n- `writings/` — writing\n',
      files: [{ rel: 'writings/writer/ch01.md', content: Buffer.from('x\n'), day: 2 }],
      policy: policyWith({
        rules: { 'top-level': { allow: ['writings', 'README.md'] } },
      }),
    };
  },

  families() {
    return {
      files: [
        { rel: 'mining/worker/cs2-gpupv/iso/Win11_stock.iso', content: blob(21, 2000), day: 2 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win11_lite.iso', content: blob(22, 2100), day: 9 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win10_old.iso', content: blob(23, 2200), day: 5 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win10_bad.iso', content: blob(24, 2300), day: 3 },
        { rel: 'mining/worker/cs2-gpupv/vm/win11.vhdx', content: blob(25, 900), day: 4 },
      ],
      policy: policyWith({
        rules: { 'top-level': { allow: ['mining', 'README.md'] } },
      }),
    };
  },

  'large-files'() {
    return {
      files: [
        { rel: 'mining/worker/cs2-gpupv/vm/Win11-LTSC-lite.vhdx', content: blob(31, 4096), day: 2 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win11_stock.iso', content: blob(32, 5000), day: 3 },
      ],
      registry: {
        version: 1,
        entries: [
          {
            path: 'mining/worker/cs2-gpupv/iso/Win11_stock.iso',
            bytes: 5000,
            purpose: 'stock install media',
            externalizable: true,
            protected: false,
            note: 'registered on purpose',
          },
        ],
      },
      policy: policyWith({
        rules: {
          'top-level': { allow: ['mining', 'README.md'] },
          'large-files': { minBytes: 4000 },
        },
      }),
    };
  },

  'protected-missing'() {
    return {
      files: [{ rel: 'writings/filter/xinghe/notes.md', content: Buffer.from('notes\n'), day: 2 }],
      policy: policyWith({
        rules: {
          'top-level': { allow: ['writings', 'README.md'] },
          protected: { patterns: ['writings/writer/**'] },
        },
        classification: { protected: ['writings/writer/**'] },
      }),
    };
  },

  'symlink-loop'(root, base) {
    return {
      files: [
        { rel: 'writings/loop-anchor.md', content: Buffer.from('anchor\n'), day: 2 },
        { rel: 'mining/escape-anchor.md', content: Buffer.from('anchor\n'), day: 3 },
        { rel: '../outside/secret.md', content: Buffer.from('never read\n'), day: 4 },
      ],
      symlinks: [
        { rel: 'writings/loop', target: '..' },
        { rel: 'mining/escape', target: '../../outside' },
        { rel: 'mining/broken', target: './does-not-exist' },
      ],
      readme: '# Symlink fixture\n\n## Top level\n\n- `writings/` — writing\n- `mining/` — mining\n',
      policy: policyWith({
        rules: { 'top-level': { allow: ['writings', 'mining', 'README.md'] } },
      }),
    };
  },

  'studio-mini'() {
    const wim = blob(7, 4096);
    return {
      readme: [
        '# Studio (synthetic) — 六件事故复现',
        '',
        '## 一、顶层目录',
        '',
        '| 目录 | 是什么 |',
        '|---|---|',
        '| `quill/` | 写作线（旧名，已改名） |',
        '| `miner/` | 搬砖线（旧名，已改名） |',
        '| `lens/` | 采集线（旧名，已改名） |',
        '| `anvil/` | 游戏线（旧名，已改名） |',
        '| `writings/` | 写作线 |',
        '| `mining/` | 搬砖线 |',
        '| `video/` | 采集线 |',
        '| `game/` | 游戏线 |',
        '| `_projects/` | 独立项目 |',
        '| `_tools/` | 工具 |',
        '| `_archive/` | 备份唯一入口 |',
        '| `_context/` | 规矩与上下文 |',
        '',
      ].join('\n'),
      files: [
        // incident 1: three byte-identical install.wim
        { rel: '_projects/cs2-vision/install.wim', content: wim, day: 20 },
        { rel: '_tools/ps/install.wim', content: wim, day: 4 },
        { rel: '_archive/20261117_rescue/install.wim', content: wim, day: 6 },
        // incident 2: four ISOs in one image directory
        { rel: 'mining/worker/cs2-gpupv/iso/Win11_stock.iso', content: blob(11, 2000), day: 2 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win11_lite.iso', content: blob(12, 2100), day: 9 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win10_old.iso', content: blob(13, 2200), day: 5 },
        { rel: 'mining/worker/cs2-gpupv/iso/Win10_bad.iso', content: blob(14, 2300), day: 3 },
        // incident 3: backups scattered outside _archive
        { rel: 'writings/_backup/notes.tar.gz', content: blob(15, 500), day: 7 },
        { rel: 'mining/worker/love.bak/actions.py', content: Buffer.from('# old\n'), day: 8 },
        // incident 5: transcribed originals still on disk (one orphan protected)
        { rel: 'video/capture/xinghe/raw/U218_delisted.mp4', content: blob(21, 9000), day: 1 },
        { rel: 'video/capture/xinghe/raw/7705047215923976320.mp4', content: blob(22, 9500), day: 2 },
        { rel: 'video/capture/xinghe/raw/U001_transcribed.mkv', content: blob(23, 9100), day: 3 },
        { rel: 'video/capture/xinghe/raw/U002_transcribed.mkv', content: blob(24, 9200), day: 4 },
        // incident 6: a big virtual disk nobody registered
        { rel: 'mining/worker/cs2-gpupv/vm/Win11-LTSC-lite.vhdx', content: blob(31, 9300), day: 5 },
        // ordinary content
        { rel: 'writings/writer/books/daiqianshi/ch01.md', content: Buffer.from('# ch1\n'), day: 6 },
        { rel: 'game/dev/plastic-world/project.godot', content: Buffer.from('config_version=5\n'), day: 7 },
        { rel: '_context/dsbot_archive_20261117/rules.md', content: Buffer.from('# rules\n'), day: 8 },
        { rel: '_archive/20261117_rescue/HANDOFF.md', content: Buffer.from('# handoff\n'), day: 9 },
      ],
      registry: {
        version: 1,
        entries: [
          {
            path: 'video/capture/xinghe/raw/7705047215923976320.mp4',
            bytes: 9500,
            purpose: 'delisted original, the only copy',
            externalizable: false,
            protected: true,
            note: 'never delete; the transcript exists but the source is gone',
          },
        ],
      },
      policy: policyWith({
        rules: {
          'top-level': {
            allow: [
              'writings',
              'mining',
              'video',
              'game',
              '_projects',
              '_tools',
              '_archive',
              '_context',
              'README.md',
            ],
          },
          'large-files': { minBytes: 8000 },
          protected: { patterns: PROTECTED_PATTERNS },
        },
        classification: { protected: PROTECTED_PATTERNS },
      }),
    };
  },
};
