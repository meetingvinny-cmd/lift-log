// migrate.test.js - schema 1 migrates with every store and every row kept (DESIGN 5.7, M7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, STORE_NAMES, validateBackup } from '../../../backup.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'backup_v1.json');

test('the v1 fixture has a row in every store but snapshots and templates', () => {
  const f = JSON.parse(readFileSync(FIX, 'utf8'));
  for (const s of STORE_NAMES.filter(x => x !== 'templates')) assert.ok(f.stores[s].length > 0, s + ' is empty in the fixture');
});

test('migrate keeps every store, every count and every row (M7)', () => {
  const v = validateBackup(readFileSync(FIX, 'utf8'), { now: Date.parse('2026-11-09T12:00:00Z') });
  assert.equal(v.ok, true, v.why);
  const out = migrate(structuredClone(v.stores), v.schema);
  assert.deepEqual(Object.keys(out).sort(), [...STORE_NAMES].sort());
  for (const s of STORE_NAMES) {
    assert.ok(Array.isArray(out[s]), 'migrate lost ' + s);
    assert.equal(out[s].length, v.stores[s].length, s + ' row count');
  }
  assert.deepEqual(out, v.stores);
});
