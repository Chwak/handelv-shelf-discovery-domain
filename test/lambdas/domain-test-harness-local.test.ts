import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('domain local test harness', () => {
  test('npm test runner is wired; package manifest readable', () => {
    const root = path.join(__dirname, '../..');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string };
    assert.ok(pkg.name && pkg.name.length > 1, 'expected package.json name');
  });
});

