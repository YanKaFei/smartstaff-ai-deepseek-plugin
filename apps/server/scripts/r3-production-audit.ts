import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { makeConfig, serverRoot, assertProductionSafety } from '../src/config.js';

const projectRoot = path.resolve(serverRoot, '..', '..');
const roots = [
  path.join(serverRoot, 'dist'),
  path.join(projectRoot, 'apps', 'admin'),
  path.join(projectRoot, 'apps', 'miniapp', 'dist', 'build'),
].filter(existsSync);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) out.push(...walk(file));
    else if (/\.(js|mjs|cjs|html|json|css)$/.test(file)) out.push(file);
  }
  return out;
}

const forbidden = [
  { id: 'default_admin_password', pattern: /admin123/g, severity: 'critical' },
  { id: 'demo_login_enabled_literal', pattern: /ALLOW_DEMO_LOGIN\s*=\s*true/g, severity: 'critical' },
  { id: 'test_admin_password', pattern: /test-admin/g, severity: 'critical' },
  { id: 'placeholder_deepseek_key', pattern: /r[12]-invalid-placeholder-key/g, severity: 'critical' },
  { id: 'literal_api_key', pattern: /sk-[A-Za-z0-9_-]{12,}/g, severity: 'critical' },
];
const findings: Array<{ id: string; severity: string; file: string; sample: string }> = [];
for (const file of roots.flatMap(walk)) {
  const text = readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({ id: rule.id, severity: rule.severity, file: path.relative(projectRoot, file), sample: match[0].slice(0, 40) });
    }
  }
}
const envLeaks = roots.flatMap(walk).filter((f) => path.basename(f) === '.env' || f.endsWith('.env.local'));

const safe = makeConfig({
  isProduction: true,
  nodeEnv: 'production',
  adminPassword: 'Str0ng!Admin#2026',
  auth: { demoLoginEnabled: false },
  corsOrigins: ['https://staff.example.com'],
  requireHttps: true,
  secretEncryptionKey: 'a'.repeat(64),
});
let productionGate = 'PASS';
try { assertProductionSafety(safe); } catch { productionGate = 'FAIL'; }
const unsafe = makeConfig({ ...safe, auth: { demoLoginEnabled: true }, adminPassword: 'admin123' });
let demoGate = 'PASS';
try { assertProductionSafety(unsafe); demoGate = 'FAIL'; } catch { demoGate = 'PASS'; }

const report = {
  checkedAt: new Date().toISOString(),
  scannedRoots: roots.map((r) => path.relative(projectRoot, r)),
  findings,
  envLeaks,
  productionGate,
  demoGate,
  status: findings.length === 0 && envLeaks.length === 0 && productionGate === 'PASS' && demoGate === 'PASS' ? 'PASS' : 'FAIL',
  note: 'This scans built artifacts for demo credentials/backdoors. It is not a substitute for a full SAST or secret scan.',
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
