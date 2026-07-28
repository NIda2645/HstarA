import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';


const root = resolve(process.cwd());
const python = resolve(root, 'python', 'python.exe');

const astAuditScript = String.raw`
import ast
import json
import pathlib
import sys

FORBIDDEN_NAMES = {
    "BASE_DIR",
    "PROGRAM_ROOT",
    "STATIC_DIR",
    "BUILTIN_WORKFLOW_DIR",
    "PACKAGED_API_DEFAULTS_FILE",
    "LEGACY_API_ENV_FILE",
}
PROGRAM_PATH_ATTRIBUTES = {
    "program_root",
    "static_dir",
    "builtin_workflow_dir",
    "api_defaults_dir",
}
PROGRAM_PATH_FUNCTIONS = set()
WRITE_FUNCTIONS = {
    "os.makedirs": (0,),
    "os.mkdir": (0,),
    "os.remove": (0,),
    "os.unlink": (0,),
    "os.rmdir": (0,),
    "os.removedirs": (0,),
    "os.replace": (0, 1),
    "os.rename": (0, 1),
    "shutil.copy": (1,),
    "shutil.copy2": (1,),
    "shutil.copyfile": (1,),
    "shutil.copytree": (1,),
    "shutil.move": (0, 1),
    "shutil.rmtree": (0,),
    "atomic_write_bytes": (0,),
    "atomic_write_json": (0,),
}
WRITE_METHODS = {
    "mkdir",
    "touch",
    "write_bytes",
    "write_text",
    "unlink",
    "rmdir",
}


def dotted_name(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return ""


def expression_is_tainted(node, tainted):
    if node is None:
        return False
    if isinstance(node, ast.Name):
        return node.id in tainted
    if isinstance(node, ast.Attribute):
        dotted = dotted_name(node)
        if dotted.startswith("RUNTIME_PATHS."):
            attribute = dotted.split(".", 1)[1].split(".", 1)[0]
            return attribute in PROGRAM_PATH_ATTRIBUTES
    if isinstance(node, ast.Call) and dotted_name(node.func) in PROGRAM_PATH_FUNCTIONS:
        return True
    return any(expression_is_tainted(child, tainted) for child in ast.iter_child_nodes(node))


def assigned_names(node):
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        result = []
        for item in node.elts:
            result.extend(assigned_names(item))
        return result
    return []


def open_mode(call):
    mode = None
    if len(call.args) > 1 and isinstance(call.args[1], ast.Constant):
        mode = call.args[1].value
    for keyword in call.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value
    return str(mode or "r")


def scoped_nodes(scope):
    for child in ast.iter_child_nodes(scope):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        yield child
        yield from scoped_nodes(child)


def nested_scopes(scope):
    for child in ast.iter_child_nodes(scope):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            yield child
        else:
            yield from nested_scopes(child)


def scope_parameters(scope):
    if not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        return set()
    arguments = scope.args
    parameters = {
        argument.arg
        for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]
    }
    if arguments.vararg:
        parameters.add(arguments.vararg.arg)
    if arguments.kwarg:
        parameters.add(arguments.kwarg.arg)
    return parameters


def inspect_scope(scope, inherited_tainted, filename, lines):
    tainted = set(inherited_tainted) - scope_parameters(scope)
    nodes = list(scoped_nodes(scope))
    assignments = []
    for node in nodes:
        if isinstance(node, ast.Assign):
            assignments.append((node.targets, node.value))
        elif isinstance(node, ast.AnnAssign):
            assignments.append(([node.target], node.value))

    changed = True
    while changed:
        changed = False
        for targets, value in assignments:
            if not expression_is_tainted(value, tainted):
                continue
            for target in targets:
                for name in assigned_names(target):
                    if name in {"RUNTIME_PATHS", "DATA_ROOT"} or name in tainted:
                        continue
                    tainted.add(name)
                    changed = True

    violations = []
    for node in nodes:
        if not isinstance(node, ast.Call):
            continue
        name = dotted_name(node.func)
        targets = []
        if name == "open":
            if node.args and any(character in open_mode(node) for character in "wax+"):
                targets.append(node.args[0])
        elif name in WRITE_FUNCTIONS:
            for index in WRITE_FUNCTIONS[name]:
                if len(node.args) > index:
                    targets.append(node.args[index])
        elif isinstance(node.func, ast.Attribute) and node.func.attr in WRITE_METHODS:
            targets.append(node.func.value)
        elif (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"rename", "replace"}
            and not isinstance(node.func.value, ast.Call)
            and expression_is_tainted(node.func.value, tainted)
        ):
            targets.append(node.func.value)
            if node.args:
                targets.append(node.args[0])
        elif name.startswith("tempfile."):
            for keyword in node.keywords:
                if keyword.arg == "dir":
                    targets.append(keyword.value)

        if any(expression_is_tainted(target, tainted) for target in targets):
            line = lines[node.lineno - 1].strip() if node.lineno <= len(lines) else name
            violations.append({"file": filename, "line": node.lineno, "call": name, "source": line})
    for child_scope in nested_scopes(scope):
        violations.extend(inspect_scope(child_scope, tainted, filename, lines))
    return violations


def inspect_file(filename):
    source = pathlib.Path(filename).read_text(encoding="utf-8-sig")
    tree = ast.parse(source, filename=filename)
    return inspect_scope(tree, FORBIDDEN_NAMES, filename, source.splitlines())


violations = []
for filename in sys.argv[1:]:
    violations.extend(inspect_file(filename))
print(json.dumps(violations, ensure_ascii=False))
`;

function walkFiles(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) files.push(path);
  }
  return files;
}

function snapshotTree(directory) {
  const snapshot = {};
  if (!existsSync(directory)) return snapshot;
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const key = relative(directory, child).split(sep).join('/');
      if (entry.isDirectory()) {
        snapshot[`${key}/`] = 'directory';
        visit(child);
      } else if (entry.isFile()) {
        const digest = createHash('sha256').update(readFileSync(child)).digest('hex');
        snapshot[key] = `file:${digest}`;
      }
    }
  };
  visit(directory);
  return snapshot;
}

function setTreeMode(directory, fileMode, directoryMode) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) setTreeMode(path, fileMode, directoryMode);
    else if (entry.isFile()) chmodSync(path, fileMode);
  }
  chmodSync(directory, directoryMode);
}

function isWithin(path, parent) {
  const child = resolve(path);
  const rootPath = resolve(parent);
  return child === rootPath || child.startsWith(`${rootPath}${sep}`);
}

test('Python sources contain no writes rooted in program-owned paths', () => {
  const mainSource = readFileSync(resolve(root, 'main.py'), 'utf8');
  assert.doesNotMatch(mainSource, /_self_restart|cmd \/k/, 'backend must not create command-shell restart scripts');
  const sources = [
    resolve(root, 'main.py'),
    ...walkFiles(resolve(root, 'hstar_runtime'), (path) => path.endsWith('.py')),
  ];
  const result = spawnSync(python, ['-c', astAuditScript, ...sources], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  assert.equal(result.status, 0, result.stderr || 'AST ownership audit failed to run');
  const violations = JSON.parse(result.stdout || '[]');
  assert.deepEqual(
    violations,
    [],
    `program-owned write targets found:\n${violations.map((item) => `${item.file}:${item.line} ${item.source}`).join('\n')}`,
  );
});

test('backend initialization writes only beneath a separate data root', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hstar-runtime-ownership-'));
  const programRoot = join(sandbox, 'program');
  const dataRoot = join(sandbox, 'data');
  const appDataRoot = join(sandbox, 'appdata');
  const packagedDefaults = join(programRoot, 'API', 'defaults', 'api-providers.json');
  try {
    mkdirSync(join(programRoot, 'static', 'runninghub'), { recursive: true });
    mkdirSync(join(programRoot, 'workflows'), { recursive: true });
    mkdirSync(dirname(packagedDefaults), { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(appDataRoot, { recursive: true });
    copyFileSync(resolve(root, 'API', 'defaults', 'api-providers.json'), packagedDefaults);
    setTreeMode(programRoot, 0o444, 0o555);
    const programBefore = snapshotTree(programRoot);
    const filesBefore = new Set(walkFiles(sandbox));

    const child = spawnSync(
      python,
      [
        '-c',
        [
          'import main',
          'main.load_api_providers()',
          'main.update_env_values({"OWNERSHIP_TEST_KEY": "temporary-value"})',
          'from fastapi import HTTPException',
          'try:\n main.update_from_github()\nexcept HTTPException as error:\n assert error.status_code == 409',
          'try:\n main.rollback_update(main.RollbackRequest())\nexcept HTTPException as error:\n assert error.status_code == 410',
        ].join('\n'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          APPDATA: appDataRoot,
          HSTAR_PROGRAM_DIR: programRoot,
          HSTAR_DATA_DIR: dataRoot,
          HSTAR_EDITION: 'test-runtime-ownership',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout || 'backend initialization failed');
    assert.deepEqual(snapshotTree(programRoot), programBefore, 'read-only program tree changed');

    const createdFiles = walkFiles(sandbox).filter((path) => !filesBefore.has(path));
    assert.ok(createdFiles.length > 0, 'backend initialization did not exercise persistent writes');
    assert.deepEqual(
      createdFiles.filter((path) => !isWithin(path, dataRoot)),
      [],
      `files escaped the data root:\n${createdFiles.join('\n')}`,
    );
    assert.ok(
      existsSync(join(dataRoot, 'config', 'api-providers.user.json')),
      'first-run API provider config was not initialized beneath data root',
    );
    assert.ok(
      existsSync(join(dataRoot, 'secrets', 'credentials.dpapi')),
      'DPAPI credential store was not initialized beneath data root',
    );
  } finally {
    setTreeMode(programRoot, 0o666, 0o777);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
