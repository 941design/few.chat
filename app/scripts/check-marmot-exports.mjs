import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marmot = path.join(app, 'src', 'lib', 'marmot');
const { config, error } = ts.readConfigFile(path.join(app, 'tsconfig.json'), ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));

const { fileNames, options } = ts.parseJsonConfigFileContent(config, ts.sys, app);
const tests = ts.sys.readDirectory(path.join(app, 'tests'), ['.ts', '.tsx']);
const program = ts.createProgram([...fileNames, ...tests], options);
const checker = program.getTypeChecker();
const consumers = new Map();

function record(symbol, source) {
  if (!symbol) return;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  let locations = consumers.get(symbol);
  if (!locations) consumers.set(symbol, locations = new Set());
  locations.add(source);
}

function recordDynamicImport(node, source) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
  if (!ts.isStringLiteral(node.arguments[0])) return;
  const resolved = ts.resolveModuleName(node.arguments[0].text, source.fileName, options, ts.sys).resolvedModule;
  const target = resolved && program.getSourceFile(resolved.resolvedFileName);
  const module = target && checker.getSymbolAtLocation(target);
  const parent = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
  let binding;
  if (ts.isVariableDeclaration(parent)) binding = parent.name;
  else if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'then' &&
    ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
    const callback = parent.parent.arguments[0];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      binding = callback.parameters[0]?.name;
    }
  }
  if (!module || !binding || !ts.isObjectBindingPattern(binding)) return;
  const exports = checker.getExportsOfModule(module);
  for (const element of binding.elements) {
    const name = element.propertyName ?? element.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      record(exports.find((symbol) => symbol.name === name.text), source);
    }
  }
}

const sources = program.getSourceFiles().filter((file) =>
  !file.isDeclarationFile && file.fileName.startsWith(app + path.sep) &&
  !file.fileName.includes(path.sep + 'node_modules' + path.sep));

for (const source of sources) {
  function visit(node) {
    // Re-exporting a name only forwards it; it does not consume the declaration.
    if (ts.isExportDeclaration(node) || ts.isImportDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const type = checker.getTypeAtLocation(node.initializer);
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) record(type.getProperty(name.text), source);
      }
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      record(checker.getShorthandAssignmentValueSymbol(node), source);
    }
    if (ts.isIdentifier(node)) record(checker.getSymbolAtLocation(node), source);
    recordDynamicImport(node, source);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

let unused = 0;
for (const source of sources) {
  if (!source.fileName.startsWith(marmot + path.sep) || path.basename(source.fileName) === 'index.ts') continue;
  const module = checker.getSymbolAtLocation(source);
  if (!module) continue;
  for (let symbol of checker.getExportsOfModule(module)) {
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol.declarations?.some((node) => node.getSourceFile() === source && !ts.isExportSpecifier(node))) continue;
    if ([...(consumers.get(symbol) ?? [])].some((consumer) => consumer !== source)) continue;
    console.error(`${path.relative(app, source.fileName)} exports unused symbol ${symbol.name}`);
    unused++;
  }
}
if (unused) process.exitCode = 1;
