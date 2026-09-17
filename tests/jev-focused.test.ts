import { afterEach, expect, it, vi } from 'vitest';
import { workedExamples, checksForRecordedMessages } from '../examples/jev-worked-examples.ts';
import { assessFocused, composeFocused, planFocusedExample } from '../src/evals/jev-focused.ts';
import { requestJevState, parseJevResponse, type Question } from '../src/evals/jev.ts';

afterEach(() => vi.unstubAllEnvs());

it('keeps author labels and unrelated candidate text out of evidence; groups only shared context', () => {
  for (const example of workedExamples) {
    const packets = planFocusedExample(example);
    const serialized = JSON.stringify(packets);
    expect(serialized).not.toContain(example.id);
    expect(serialized).not.toContain('scoreLevel');
    expect(serialized).not.toContain('failures');
    for (const packet of packets) {
      if (packet.kind === 'claim')
        expect(Object.keys(packet.state ?? {})).toEqual(['source_context', 'claim']);
      if (packet.kind === 'field')
        expect(Object.keys(packet.state ?? {})).toEqual(['source_context', 'candidate_field']);
    }
  }
  const packets = planFocusedExample(workedExamples[0]);
  expect(Object.keys(packets[0].questions)).toEqual(['muted_condition', 'mention_trigger']);
  expect(Object.keys(packets[1].questions)).toEqual(['notification_count']);
});

it('rejects invented source excerpts, nonexistent candidate claims and duplicate checks before calling the API', () => {
  const original = workedExamples[0];
  expect(() =>
    planFocusedExample({
      ...original,
      checks: [{ ...original.checks[0], sourceQuote: 'Invented evidence.' }],
    }),
  ).toThrow('verbatim source');
  expect(() =>
    planFocusedExample({
      ...original,
      claims: [{ ...original.claims[0], quote: 'Not in the output.' }],
    }),
  ).toThrow('verbatim candidate');
  expect(() =>
    planFocusedExample({ ...original, checks: [...original.checks, original.checks[0]] }),
  ).toThrow('duplicate');
  expect(checksForRecordedMessages([{ role: 'user', text: 'An unfamiliar task.' }])).toBeNull();
});

it('flags a single error despite perfect quality, preserves uncertainty and distinguishes transport errors', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-secret');
  const example = workedExamples[1];
  const packets = planFocusedExample(example);
  const records = [];
  for (const packet of packets) {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        model: 'jev-test',
        usage: { input_tokens: 50, output_tokens: 0 },
        answers: Object.fromEntries(
          Object.entries(packet.questions).map(([id, q]) => [
            id,
            q.type === 'noul'
              ? { type: 'noul', noul: id === 'muted_condition' ? 0.98 : 0.01 }
              : q.type === 'choice'
                ? {
                    type: 'choice',
                    choice: 'supported',
                    probabilities: { supported: 1, contradicted: 0, unsupported: 0 },
                    confidence: 1,
                  }
                : {
                    type: 'score',
                    score: 3,
                    confidence: 1,
                    probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
                    legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])),
                  },
          ]),
        ),
      }),
    );
    records.push(await requestJevState(packet.state, packet.questions, { fetch: fakeFetch }));
  }
  expect(composeFocused(packets, records)).toMatchObject({
    disposition: 'flag',
    flagged: ['muted_condition'],
  });
  const response = records[0].response;
  if (!response) throw new Error('Missing mock response.');
  response.answers.muted_condition = { type: 'noul', noul: 0.5 };
  expect(composeFocused(packets, records)).toMatchObject({
    disposition: 'review',
    uncertain: ['muted_condition'],
  });
  response.answers.muted_condition = { type: 'noul', noul: 0.02 };
  expect(composeFocused(packets, records).disposition).toBe('checks_clear');
  expect(composeFocused(packets, records.slice(1)).disposition).toBe('error');
  expect(JSON.stringify(records)).not.toContain('test-secret');
  records[1].request.state = { wrong: 'context' };
  expect(composeFocused(packets, records).disposition).toBe('error');
  const failed = await assessFocused(example, {
    fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 429 })),
  });
  expect(failed.decision.disposition).toBe('error');
  expect(failed.records).toHaveLength(packets.length);
});

it('accepts structured Score legends and validates their contents', () => {
  const levels = [{ meaning: 'low' }, { meaning: 'high' }];
  const questions: Record<string, Question> = {
    quality: { type: 'score', instructions: { question: 'How good?' }, criteria: levels },
  };
  const raw = {
    model: 'test',
    usage: { input_tokens: 1, output_tokens: 0 },
    answers: {
      quality: {
        type: 'score',
        score: 1,
        confidence: 1,
        probabilities: { 0: 0, 1: 1 },
        legend: { 0: { meaning: 'low' }, 1: { meaning: 'high' } },
      },
    },
  };
  expect(parseJevResponse(raw, questions).answers.quality).toMatchObject({ score: 1 });
  raw.answers.quality.legend[1].meaning = 'different';
  expect(() => parseJevResponse(raw, questions)).toThrow('legend');
});
