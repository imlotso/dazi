import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
mkdirSync(resolve('dist'), { recursive: true });
const output = mkdtempSync(resolve('dist/vercel-esm-check-'));
try {
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: false, noEmitOnError: true, outDir: output, rootDir: root,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const program = ts.createProgram([resolve('api/handler.ts')], options);
  const emitted = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n',
  }));
  const entry = pathToFileURL(join(output, 'api/handler.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', entry], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Node could not import the emitted Function');
  console.log('Node imported the emitted Vercel Function successfully.');
} finally { rmSync(output, { recursive: true, force: true }); }
