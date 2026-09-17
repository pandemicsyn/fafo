import { afterEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
  assessJev,
  decideJev,
  jevQuestions,
  parseJevResponse,
  requestJev,
  type Question,
} from '../src/evals/jev.ts';
import { JsonValueSchema, parseJson } from '../src/json.ts';

afterEach(() => vi.unstubAllEnvs());
const input = {
  report: 'Search and press Escape. Expected all issues; actual list stays filtered.',
  issue: 'Search and press Escape. Expected all issues; actual list stays filtered. Cause: Redux.',
  claim: 'Redux caused it.',
};
function responseFor(questions: Record<string, Question>) {
  return {
    model: 'jev-test',
    usage: { input_tokens: 100, output_tokens: 10 },
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'noul'
          ? { type: 'noul', noul: id === 'invented_failure' ? 0.98 : 0.01 }
          : question.type === 'choice'
            ? {
                type: 'choice',
                choice: 'unsupported',
                confidence: 0.99,
                probabilities: { supported: 0, contradicted: 0, unsupported: 1 },
              }
            : {
                type: 'score',
                score: 2,
                confidence: 1,
                probabilities: { 0: 0, 1: 0, 2: 1 },
                legend: Object.fromEntries(question.criteria.map((level, i) => [i, level])),
              },
      ]),
    ),
  };
}
it('uses independent failure checks and keeps diagnostic Choice/Score out of the verdict', () => {
  const questions = jevQuestions(input);
  const { answers } = parseJevResponse(responseFor(questions), questions);
  expect(decideJev(answers, { accept: 0.1, reject: 0.9 })).toBe('fail');
  answers.invented_failure = { type: 'noul', noul: 0.4 };
  expect(decideJev(answers, { accept: 0.1, reject: 0.9 })).toBe('review');
  answers.invented_failure = { type: 'noul', noul: 0.01 };
  expect(decideJev(answers, { accept: 0.1, reject: 0.9 })).toBe('pass');
  expect(() => decideJev({}, { accept: 0.1, reject: 0.9 })).toThrow('Missing');
  expect(() => decideJev(answers, { accept: 0.9, reject: 0.1 })).toThrow('Thresholds');
  expect(jevQuestions({ report: 'r', issue: 'i' })).not.toHaveProperty('claim_relation');
});
it('rejects missing answers, bad probabilities and mismatched score legends', () => {
  const questions = jevQuestions(input);
  const good = responseFor(questions);
  expect(() => parseJevResponse({ ...good, answers: {} }, questions)).toThrow('question IDs');
  for (const answer of [
    { type: 'noul', noul: 1.01 },
    { type: 'choice', choice: 'pass', probabilities: { pass: 1 }, confidence: 1 },
  ])
    expect(() =>
      parseJevResponse(
        { ...good, answers: { ...good.answers, invented_failure: answer } },
        questions,
      ),
    ).toThrow();
  expect(() =>
    parseJevResponse(
      {
        ...good,
        answers: {
          ...good.answers,
          claim_relation: {
            type: 'choice',
            choice: 'unsupported',
            probabilities: { supported: 0, contradicted: 0, unsupported: 0.2 },
            confidence: 1,
          },
        },
      },
      questions,
    ),
  ).toThrow('distribution');
  expect(() =>
    parseJevResponse(
      {
        ...good,
        answers: {
          ...good.answers,
          reproduction_coverage: {
            type: 'score',
            score: 2,
            probabilities: { 0: 0, 1: 0, 2: 1 },
            confidence: 1,
            legend: { 0: 'wrong', 1: 'wrong', 2: 'wrong' },
          },
        },
      },
      questions,
    ),
  ).toThrow('legend');
});
it('whitelists judge state and never saves credentials or sends human labels', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'secret-test-key');
  vi.stubEnv('TYPESAFE_MODEL', 'old-model-setting');
  const questions = jevQuestions(input);
  const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responseFor(questions)));
  const extra = { ...input, human: 'fail', expected: 'fail', id: 'test' };
  const record = await requestJev(extra, questions, { fetch: fakeFetch });
  const body = fakeFetch.mock.calls[0][1]?.body;
  if (typeof body !== 'string') throw new Error('Missing body.');
  const request = v.parse(
    v.object({ state: v.record(v.string(), JsonValueSchema) }),
    parseJson(body),
  );
  expect(request.state).toEqual(input);
  expect(record.error).toBeNull();
  expect(record.request.model).toBe('jev-latest');
  expect(JSON.stringify(record)).not.toContain('secret-test-key');
});
it('records failed calls exactly once and does not produce a semantic grade', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test');
  for (const response of [
    new Response('rate limited', { status: 429 }),
    new Response('not json'),
    Response.json({}),
  ]) {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await assessJev(input, { fetch: fakeFetch });
    expect(result.status).toBe('error');
    expect(result.verdict).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.requests[0].raw).not.toBeNull();
    expect(result.requests[0].retries).toBe(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  }
});
it('batches or splits the same questions, preserving all successful and failed requests', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test');
  const questions = jevQuestions(input);
  for (const strategy of ['batched', 'sequential', 'concurrent'] as const) {
    const fakeFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Missing body.');
      const request = v.parse(
        v.object({ questions: v.record(v.string(), JsonValueSchema) }),
        parseJson(init.body),
      );
      const subset = Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, questions[id]]),
      );
      return Response.json(responseFor(subset));
    });
    const result = await assessJev(input, { strategy, fetch: fakeFetch });
    expect(result.verdict).toBe('fail');
    expect(result.answers).toEqual(parseJevResponse(responseFor(questions), questions).answers);
    expect(fakeFetch).toHaveBeenCalledTimes(strategy === 'batched' ? 1 : 7);
    expect(result.usage?.inputTokens).toBe(strategy === 'batched' ? 100 : 700);
  }
});
