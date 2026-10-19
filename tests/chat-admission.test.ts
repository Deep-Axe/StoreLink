import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatAdmission,
  ChatBusyError,
} from '../services/gateway/src/chat-admission.ts';

test('busy denials do not consume quota and team slots do not block other teams', () => {
  const admission = new ChatAdmission({ perUserHour: 2 });
  const releases = Array.from({ length: 4 }, (_, i) =>
    admission.acquire(`a${i}`, 'a'),
  );
  assert.throws(() => admission.acquire('busy', 'a'), ChatBusyError);
  const other = admission.acquire('b', 'b');
  other();
  releases.forEach((release) => release());
  const first = admission.acquire('busy', 'a');
  first();
  first();
  const second = admission.acquire('busy', 'a');
  second();
  assert.throws(() => admission.acquire('busy', 'a'), /Hourly/);
});
test('global/user/conversation admission is bounded and time windows expire', () => {
  const admission = new ChatAdmission({
    perUserHour: 1,
    perUserConcurrent: 2,
    globalConcurrent: 2,
  });
  const first = admission.acquire('one', 'a', 'shared', 0);
  assert.throws(() => admission.acquire('two', 'a', 'shared', 0), /busy/);
  const second = admission.acquire('two', 'b', undefined, 0);
  assert.throws(() => admission.acquire('three', 'c', undefined, 0), /busy/);
  first();
  second();
  const later = admission.acquire('one', 'a', 'shared', 3600001);
  later();
  assert.throws(
    () => new ChatAdmission({ globalConcurrent: 0 }),
    /positive integers/,
  );
});
