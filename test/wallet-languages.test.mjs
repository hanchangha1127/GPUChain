import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { locales, translate } from '../ui/wallet/i18n.js';

test('the local wallet starts in English and exposes all five languages',async()=>{
  const page=await readFile(new URL('../ui/wallet/index.html',import.meta.url),'utf8');
  assert.ok(page.includes('<html lang="en">'));
  assert.deepEqual(locales,['en','ko','ja','zh-CN','fr']);
  for (const language of locales) assert.ok(page.includes('value="'+language+'"'));
  const ids=Array.from(page.matchAll(/data-i18n="([^"]+)"/g),m=>m[1]);
  assert.ok(ids.length>30);
  for (const id of ids) {
    assert.equal(translate('en',id),id);
    assert.notEqual(translate('ko',id),id);
  }
  assert.equal(translate('fr','Epoch {n} progress',{n:2}),'Progression de l’époque 2');
});
